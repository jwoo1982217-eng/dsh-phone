package com.dshphone.control

import java.util.UUID

/** Process-local consent. Nothing survives a restart, disable, expiry or stop. */
class ControlLease(private val now: () -> Long, private val blocked: (String) -> Boolean) {
    data class Request(val id: String, val owner: String, val task: String, val packages: Set<String>, val minutes: Int, val deadline: Long)
    data class Grant(val id: String, val owner: String, val task: String, val packages: Set<String>, val deadline: Long, val epoch: Long, val continuous: Boolean = false, val allApps: Boolean = false, val policyMode: String? = null)
    var epoch = 0L; private set
    private var pending: Request? = null
    private var grant: Grant? = null

    @Synchronized fun request(owner: String, task: String, packages: Set<String>, minutes: Int): Request {
        require(owner.matches(Regex("[a-zA-Z0-9_-]{1,128}")) && !owner.startsWith("qq-")) { "只允许手机本机会话申请" }
        require(task.isNotBlank() && task.length <= 500) { "请提供本次任务，最多 500 字" }
        require(packages.size in 1..8 && packages.none { blocked(it) || !it.matches(Regex("[a-zA-Z0-9_]+(?:\\.[a-zA-Z0-9_]+)+")) }) { "请选择 1–8 个可操作 App，不包含系统授权或 DSH" }
        require(minutes in 1..30) { "授权时长为 1–30 分钟" }
        currentRequest()?.let { if (it.owner == owner && it.task == task && it.packages == packages && it.minutes == minutes) return it }
        check(currentRequest() == null) { "已有待确认申请，请在手机操作页取消后再申请" }
        return Request(UUID.randomUUID().toString(), owner, task, packages.toSet(), minutes, now() + 300_000).also { pending = it }
    }

    @Synchronized fun currentRequest(): Request? {
        if (pending?.deadline?.let { now() >= it } == true) pending = null
        return pending
    }
    @Synchronized fun current(): Grant? {
        if (grant?.deadline?.let { now() >= it } == true) clearGrant()
        return grant
    }
    @Synchronized fun approve(id: String): Grant {
        val request = currentRequest() ?: error("申请已过期，请重新申请")
        check(request.id == id) { "申请已经变化，请重新查看" }
        epoch++
        return Grant(UUID.randomUUID().toString(), request.owner, request.task, request.packages, now() + request.minutes * 60_000, epoch).also { grant = it; pending = null }
    }
    /** Mode comes from the host's existing per-session sandbox policy, never tool arguments. */
    @Synchronized fun claim(owner: String, mode: String): Grant {
        require(owner.matches(Regex("[a-zA-Z0-9_-]{1,128}")) && !owner.startsWith("qq-") && !owner.startsWith("cloud-")) { "手机工具只供手机 DSH 普通会话" }
        require(mode in setOf("read-only", "workspace-write", "danger-full-access")) { "会话权限模式无效" }
        current()?.let { if (it.owner == owner && it.policyMode == mode) return it }
        epoch++
        return Grant(UUID.randomUUID().toString(), owner, "手机工具", emptySet(), Long.MAX_VALUE, epoch, mode == "danger-full-access", true, mode).also { grant = it }
    }
    @Synchronized fun check(owner: String, packageName: String? = null, expectedEpoch: Long? = null): Grant {
        val active = current() ?: error("尚未授权或授权已结束，请在服务→手机操作确认")
        check(active.owner == owner) { "本次授权属于另一个会话" }
        check(expectedEpoch == null || active.epoch == expectedEpoch) { "授权已撤回或变化，操作未执行" }
        check(packageName == null || (!blocked(packageName) && (active.allApps || packageName in active.packages))) { "当前 App 不在本次授权范围内" }
        return active
    }
    @Synchronized fun clearGrant() { epoch++; grant = null; pending = null }
    @Synchronized fun stop() { clearGrant() }
}
