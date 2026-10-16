package com.dshphone.control

import android.content.Context
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import org.json.JSONObject
import java.io.File
import java.util.Locale

/** System speech writes only into a UUID's private DSH media directory. */
object MediaSpeech {
    private val handler = Handler(Looper.getMainLooper())
    private val active = mutableMapOf<String, TextToSpeech>()
    private fun directory(ctx: Context, id: String): File {
        require(id.matches(Regex("[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}"))) { "媒体任务标识无效" }
        // Android aliases /data/user/0 to /data/data; normalize that trusted base,
        // then reject symlinks at the caller-selected UUID directory itself.
        val base = File(ctx.filesDir, "dsh-home/storage/media/jobs").canonicalFile
        val root = File(base, id)
        root.mkdirs(); require(root.canonicalFile == root.absoluteFile) { "媒体目录不能含符号链接" }; return root
    }
    private fun write(root: File, status: String, message: String? = null) {
        val target = File(root, "speech-status.json")
        val temp = File(root, "speech-status.tmp")
        temp.writeText(JSONObject().put("status", status).apply { if (message != null) put("error", message) }.toString())
        check(temp.renameTo(target)) { "语音状态保存失败" }
    }
    fun begin(ctx: Context, payload: JSONObject): JSONObject {
        val id = payload.getString("jobId")
        val root = directory(ctx, id)
        val text = payload.getString("text")
        require(text.isNotBlank() && text.length <= 4000) { "朗读文字为空或过长" }
        val language = payload.optString("language", "zh-CN")
        require(language.matches(Regex("[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*"))) { "语言代码无效" }
        // A persisted receipt makes retries after an IPC interruption idempotent.
        if (File(root, "speech-status.json").exists()) return result(ctx, id)
        check(active.size < 2) { "已有两个语音任务处理中" }
        write(root, "in_progress")
        val temporary = File(root, "speech.partial.wav")
        val attemptedEngines = mutableSetOf<String>()
        fun finish(error: String?) {
            handler.post {
                if (!active.containsKey(id)) return@post
                active.remove(id)?.shutdown()
                try {
                    if (error == null && MediaWave.isAudible(temporary) && temporary.renameTo(File(root, "speech.wav"))) write(root, "completed")
                    else { temporary.delete(); write(root, "failed", error ?: "语音引擎返回空白或无效音频，请检查该引擎的音源配置") }
                } catch (_: Throwable) { temporary.delete(); runCatching { write(root, "failed", "语音结果保存失败") } }
            }
        }
        fun initialize(engineName: String? = null) {
        var engine: TextToSpeech? = null
        val listener = TextToSpeech.OnInitListener { status ->
            handler.post {
                val tts = engine ?: return@post
                if (active[id] !== tts) return@post
                try {
                    val locale = Locale.forLanguageTag(language)
                    // Android setLanguage fetches the entire voice catalogue. Some
                    // custom engines fail this Binder call; their selected default
                    // language is already initialized and needs no catalogue read.
                    @Suppress("DEPRECATION")
                    val sameDefaultLanguage = status == TextToSpeech.SUCCESS && runCatching {
                        val current = tts.language
                        current.isO3Language == locale.isO3Language && (locale.country.isBlank() || current.isO3Country == locale.isO3Country)
                    }.getOrDefault(false)
                    val supported = status == TextToSpeech.SUCCESS && tts.isLanguageAvailable(locale) >= TextToSpeech.LANG_AVAILABLE &&
                        (sameDefaultLanguage || tts.setLanguage(locale) >= TextToSpeech.LANG_AVAILABLE)
                    // Only try another installed engine before synthesis has been submitted.
                    // Keep the user's system default intact and never repeat an uncertain job.
                    attemptedEngines.add(engineName ?: tts.defaultEngine)
                    if (!supported && payload.optString("voice").isBlank()) {
                        val installed = tts.engines.map { it.name }.toSet()
                        val fallback = listOf("com.samsung.SMT", "com.google.android.tts", "com.github.jing332.tts_server_android", "com.lenovo.menu_assistant.hd").firstOrNull { it in installed && it !in attemptedEngines }
                        if (fallback != null) {
                            active.remove(id)?.shutdown()
                            initialize(fallback)
                            return@post
                        }
                    }
                    check(status == TextToSpeech.SUCCESS) { "系统语音引擎初始化失败" }
                    check(supported) { "已安装的语音引擎没有此语言，请在系统文字转语音设置安装语音数据" }
                    val voice = payload.optString("voice")
                    if (voice.isNotBlank()) check(tts.setVoice(tts.voices.firstOrNull { it.name == voice } ?: error("系统语音引擎没有请求的音色")) == TextToSpeech.SUCCESS) { "音色切换失败" }
                    tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                        override fun onStart(utteranceId: String?) {}
                        override fun onDone(utteranceId: String?) { finish(null) }
                        @Deprecated("Deprecated in Java") override fun onError(utteranceId: String?) { finish("系统语音合成失败") }
                        override fun onError(utteranceId: String?, errorCode: Int) { finish("系统语音合成失败：$errorCode") }
                    })
                    check(tts.synthesizeToFile(text, Bundle(), temporary, id) == TextToSpeech.SUCCESS) { "系统语音合成提交失败" }
                } catch (error: Throwable) { finish(error.message ?: "系统语音合成失败") }
            }
        }
        engine = if (engineName == null) TextToSpeech(ctx.applicationContext, listener)
            else TextToSpeech(ctx.applicationContext, listener, engineName)
        active[id] = checkNotNull(engine)
        }
        initialize()
        handler.postDelayed({ if (active.containsKey(id)) finish("系统语音合成超过120秒，已停止") }, 120_000)
        return JSONObject().put("status", "in_progress")
    }
    fun result(ctx: Context, id: String): JSONObject {
        val root = directory(ctx, id)
        val file = File(root, "speech-status.json")
        check(file.exists() && file.length() < 4096) { "原生语音任务不存在" }
        val value = JSONObject(file.readText())
        if (value.optString("status") == "in_progress" && !active.containsKey(id)) {
            write(root, "failed", "应用在语音结果确认前重启，未自动重复生成")
            return JSONObject(File(root, "speech-status.json").readText())
        }
        return value
    }
}
