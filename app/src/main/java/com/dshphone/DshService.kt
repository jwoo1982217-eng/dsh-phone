package com.dshphone

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import java.io.File
import java.text.SimpleDateFormat
import java.util.ArrayDeque
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * 前台服务：保活 dsh（Node 子进程）。
 * - 进程死亡自动重启（5s 退避）；
 * - stdout 汇入环形缓冲（UI 读取）并追加到 dsh-console.log；
 * - stopWithTask=false：划掉任务卡片服务不停止。
 */
class DshService : Service() {
    companion object {
        const val ACTION_STOP = "com.dshphone.STOP"
        const val ACTION_RESTART = "com.dshphone.RESTART"
        const val ACTION_BACKUP = "com.dshphone.BACKUP"
        const val ACTION_RESTORE = "com.dshphone.RESTORE"
        const val ACTION_DISABLE_PLUGINS = "com.dshphone.DISABLE_PLUGINS"
        const val ACTION_INSTALL_PLUGIN = "com.dshphone.INSTALL_PLUGIN"
        const val CHANNEL_ID = "dsh"
        const val NOTIFICATION_ID = 1
        private const val MAX_LOG_LINES = 400

        @Volatile var process: Process? = null
            private set
        val logs = ArrayDeque<String>()
        @Volatile var startedAt: Long = 0
        @Volatile var lastExitCode: Int? = null
        @Volatile var restartCount: Int = 0
        @Volatile var browserLaunchUrl: String? = null
            private set
        @Volatile var recoveryBusy = false
            private set
        @Volatile var recoveryMessage = ""
            private set

        fun localStartUrl(): String = browserLaunchUrl ?: "http://127.0.0.1:3080/"

        private fun captureLaunchUrl(line: String): String {
            if (line.startsWith("dsh web: ")) {
                Regex("http://127\\.0\\.0\\.1:3080/\\?token=[A-Za-z0-9._~-]+")
                    .find(line)?.value?.let { browserLaunchUrl = it }
            }
            return line.replace(Regex("([?&]token=)[^&\\s]+"), "$1[redacted]")
        }

        fun snapshotLogs(): List<String> = synchronized(logs) { logs.toList() }

        fun appendLog(line: String) = synchronized(logs) {
            val ts = SimpleDateFormat("HH:mm:ss", Locale.US).format(Date())
            logs.addLast("$ts  $line")
            while (logs.size > MAX_LOG_LINES) logs.removeFirst()
        }

        fun killNode() {
            browserLaunchUrl = null
            runCatching { process?.destroy() }
            process = null
        }
    }

    private val handler = Handler(Looper.getMainLooper())
    private val work = Executors.newSingleThreadExecutor()
    @Volatile private var stopping = false
    @Volatile private var maintenance = false
    private val watchdog = object : Runnable {
        override fun run() {
            if (stopping || maintenance) return
            val p = process
            if (p != null && !p.isAlive) {
                lastExitCode = runCatching { p.exitValue() }.getOrNull()
                appendLog("node 已退出（exit=${lastExitCode}），5 秒后重启")
                killNode()
                handler.postDelayed({ if (!stopping && !maintenance) work.execute { startNode() } }, 5_000)
            }
            handler.postDelayed(this, 5_000)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        // Keep the app's private root private even after a faulty archive import.
        android.system.Os.chmod(applicationInfo.dataDir, 0x1c0)
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "dsh 网关", NotificationManager.IMPORTANCE_LOW)
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (maintenance) return START_STICKY
        if (intent?.action in listOf(ACTION_BACKUP, ACTION_RESTORE, ACTION_DISABLE_PLUGINS, ACTION_INSTALL_PLUGIN)) {
            maintenance = true
            recoveryBusy = true
            recoveryMessage = "正在检查任务状态…"
            handler.removeCallbacksAndMessages(null)
            startAsForeground()
            val action = intent!!.action
            val cookie = intent.getStringExtra("cookie").orEmpty()
            val allowUnknown = intent.getBooleanExtra("allowUnknown", false)
            val slot = intent.getStringExtra("slot") ?: "latest"
            val plugins = intent.getStringArrayListExtra("plugins")?.toList().orEmpty()
            val ticket = intent.getStringExtra("ticket").orEmpty()
            work.execute {
                val wasRunning = process?.isAlive == true
                var resume = wasRunning
                try {
                    check(!TrialInstaller.running()) { "前一次安装进程仍在退出，请稍后再操作" }
                    val count = LocalSessionStatus.activeCount(cookie)
                    check(count == null || count == 0) { "仍有 $count 个 AI 任务运行，请等任务结束后再操作" }
                    check(count != null || !NodeRunner.portOpen(NodeRunner.WEB_PORT) || allowUnknown) { "无法确认任务状态，请重新打开备份窗口确认" }
                    val plan = if (action == ACTION_INSTALL_PLUGIN) TrialInstaller.claim(ticket, cookie) else null
                    recoveryMessage = "正在安全停止本机服务…"
                    stopNodeGracefully()
                    if (action == ACTION_INSTALL_PLUGIN) {
                        recoveryMessage = "正在自动备份安装前的环境…"
                        RecoveryManager.backup(applicationContext)
                        recoveryMessage = "备份完成，正在下载并试装 ${plan!!.getString("name")}…"
                        try {
                            TrialInstaller.install(applicationContext, plan)
                            recoveryMessage = "${plan.getString("name")} 试装完成。若启动或界面异常，请恢复最近备份"
                        } catch (error: Exception) {
                            if (error is TrialInstaller.StillRunning) { resume = false; throw error }
                            recoveryMessage = "试装未完成，正在恢复安装前的环境…"
                            RecoveryManager.restore(applicationContext, "latest")
                            throw IllegalStateException("${error.message}；已恢复安装前环境", error)
                        }
                        resume = true
                    } else if (action == ACTION_BACKUP) {
                        recoveryMessage = "正在备份插件和配置…"
                        RecoveryManager.backup(applicationContext)
                        recoveryMessage = "备份完成，可以安装插件了"
                    } else if (action == ACTION_DISABLE_PLUGINS) {
                        recoveryMessage = "正在备份并禁用所选社区插件…"
                        RecoveryManager.disablePlugins(applicationContext, plugins)
                        recoveryMessage = "社区插件已禁用，对话与账号已保留"
                        resume = true
                    } else {
                        recoveryMessage = "正在校验并恢复备份…"
                        RecoveryManager.restore(applicationContext, slot)
                        recoveryMessage = "恢复完成，对话、账号和配对信息已保留"
                        resume = true
                    }
                } catch (error: Exception) {
                    recoveryMessage = "操作未完成：${error.message}"
                    appendLog(recoveryMessage)
                } finally {
                    maintenance = false
                    recoveryBusy = false
                    if (resume && !stopping && process?.isAlive != true) startNode()
                    handler.post {
                        if (!stopping) handler.postDelayed(watchdog, 5_000)
                        if (!resume && process?.isAlive != true) { stopForeground(STOP_FOREGROUND_REMOVE); stopSelf(startId) }
                    }
                }
            }
            return START_STICKY
        }
        if (intent?.action == ACTION_STOP) {
            com.dshphone.control.ControlRuntime.stop("DSH 服务已停止")
            stopping = true
            handler.removeCallbacksAndMessages(null)
            appendLog("收到停止指令")
            work.execute {
                runCatching { stopNodeGracefully() }.onFailure { appendLog("停止未完成：${it.message}") }
                handler.post { stopForeground(STOP_FOREGROUND_REMOVE); stopSelf(startId) }
            }
            return START_NOT_STICKY
        }
        stopping = false
        startAsForeground()
        work.execute {
            if (stopping || maintenance) return@execute
            runCatching {
                if (intent?.action == ACTION_RESTART) stopNodeGracefully()
                // Never replace a running engine's program files.
                if (process?.isAlive != true) { NodeRunner.ensureExtracted(applicationContext); startNode() }
            }.onFailure { appendLog("启动未完成: ${it.message}") }
        }
        handler.removeCallbacks(watchdog)
        handler.postDelayed(watchdog, 5_000)
        return START_STICKY
    }

    private fun startAsForeground() {
        val notification: Notification =
            Notification.Builder(this, CHANNEL_ID)
                .setContentTitle("dsh 手机版运行中")
                .setContentText("网关 127.0.0.1:8326 · 管理页 127.0.0.1:3080")
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setOngoing(true)
                .build()
        if (android.os.Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, notification,
                android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    @Synchronized
    private fun stopNodeGracefully() {
        val child = process ?: return
        if (child.isAlive) {
            child.destroy()
            check(child.waitFor(30, TimeUnit.SECONDS)) { "服务尚未安全停止，未修改运行环境，请稍后重试" }
        }
        killNode()
    }

    @Synchronized
    private fun startNode() {
        com.dshphone.control.ControlRuntime.stop("DSH 服务重新启动")
        if (stopping || maintenance) return
        val ctx = applicationContext
        killNode()
        val p = runCatching { NodeRunner.start(ctx) }
        process = p.getOrNull()
        if (p.isFailure) {
            appendLog("node 启动失败: ${p.exceptionOrNull()?.message}")
            return
        }
        startedAt = System.currentTimeMillis()
        restartCount++
        appendLog("node 已启动（第 $restartCount 次）")
        Thread {
            runCatching {
                p.getOrThrow().inputStream.bufferedReader().forEachLine { line ->
                    val safeLine = captureLaunchUrl(line)
                    appendLog(safeLine)
                    runCatching {
                        NodeRunner.consoleLog(ctx).appendText(safeLine + "\n")
                    }
                }
            }
            appendLog("node stdout 流结束")
        }.start()
    }

    override fun onDestroy() {
        com.dshphone.control.ControlRuntime.stop("DSH 服务已关闭")
        stopping = true
        handler.removeCallbacksAndMessages(null)
        killNode()
        work.shutdown()
        super.onDestroy()
    }
}
