package com.dshphone.terminal

import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class ShellSessionTest {
    private fun await(check: () -> Boolean) {
        val end = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (!check() && System.nanoTime() < end) Thread.sleep(10)
        assertTrue("timed out waiting for shell state/output", check())
    }
    private fun shell(): ShellSession = ShellSession(ShellSession.Factory {
        val process = ProcessBuilder("/bin/bash", "--noprofile", "--norc").redirectErrorStream(true).start()
        object : ShellSession.Child {
            override val stdout = process.inputStream
            override val stdin = process.outputStream
            override fun waitFor() = process.waitFor()
            override fun terminate(): String? {
                val handleType = Class.forName("java.lang.ProcessHandle")
                val handle = Process::class.java.getMethod("toHandle").invoke(process)
                @Suppress("UNCHECKED_CAST")
                val descendants = handleType.getMethod("descendants").invoke(handle) as java.util.stream.Stream<Any>
                descendants.use { children -> children.forEach { handleType.getMethod("destroyForcibly").invoke(it) } }
                process.destroyForcibly()
                process.inputStream.close(); process.outputStream.close()
                process.waitFor(2, TimeUnit.SECONDS)
                return null
            }
        }
    })
    @Test fun lineCommandsRetainDirectoryAndMergeErrorsWithoutStartingEngine() {
        shell().use { session ->
            session.start(); await { session.snapshot().state == ShellSession.State.READY }
            assertTrue(session.submit("cd /; pwd; printf 'marker-中文'; printf 'stderr-marker' >&2"))
            await { session.snapshot().output.contains("marker-中文stderr-marker") }
            assertTrue(session.snapshot().output.contains("/\n"))
            assertTrue(session.snapshot().output.contains("marker-中文"))
        }
    }
    @Test fun outputIsBoundedEvenWithoutNewlineAndCommandsRejectNulOrOversize() {
        shell().use { session ->
            session.start(); await { session.snapshot().state == ShellSession.State.READY }
            assertFalse(session.submit("a\u0000b")); assertFalse(session.submit("x".repeat(8193)))
            assertTrue(session.submit("printf '%100000s' end; printf tail-done"))
            await { session.snapshot().output.endsWith("tail-done") }
            assertTrue(session.snapshot().output.length <= 65536)
            session.clearOutput(); assertEquals("", session.snapshot().output)
        }
    }
    @Test fun exitAndReconnectReturnExplicitStates() {
        shell().use { session ->
            session.start(); await { session.snapshot().state == ShellSession.State.READY }
            session.submit("exit 7"); await { session.snapshot().state == ShellSession.State.EXITED }
            assertTrue(session.snapshot().status.contains("7"))
            session.start(); await { session.snapshot().state == ShellSession.State.READY }
            session.submit("printf recovered"); await { session.snapshot().output.endsWith("recovered") }
        }
    }
    @Test fun closeDuringLaunchKillsLateProcessAndNeverPublishesReady() {
        val entered = CountDownLatch(1); val release = CountDownLatch(1); val terminated = AtomicInteger()
        val session = ShellSession(ShellSession.Factory {
            entered.countDown(); release.await(3, TimeUnit.SECONDS)
            object : ShellSession.Child {
                override val stdout = java.io.ByteArrayInputStream(byteArrayOf())
                override val stdin = java.io.ByteArrayOutputStream()
                override fun waitFor() = 0
                override fun terminate(): String? { terminated.incrementAndGet(); return null }
            }
        })
        session.start(); assertTrue(entered.await(2, TimeUnit.SECONDS)); session.close(); release.countDown()
        await { terminated.get() == 1 }; assertEquals(ShellSession.State.CLOSED, session.snapshot().state)
        assertFalse(session.submit("pwd"))
    }
    @Test fun launchFailureIsVisibleAndRetryWorks() {
        val attempts = AtomicInteger()
        val session = ShellSession(ShellSession.Factory {
            attempts.incrementAndGet(); throw java.io.IOException("fixture-exec-denied")
        })
        session.use {
            it.start(); await { it.snapshot().state == ShellSession.State.FAILED }
            assertTrue(it.snapshot().status.contains("fixture-exec-denied"))
            it.start(); await { attempts.get() == 2 && it.snapshot().state == ShellSession.State.FAILED }
        }
    }
    @Test fun stopKillsForegroundCommandAndReconnectDoesNotReceiveItsLateOutput() {
        shell().use { session ->
            session.start(); await { session.snapshot().state == ShellSession.State.READY }
            session.submit("printf old-start; sleep 30; printf stale-output")
            await { session.snapshot().output.endsWith("old-start") }
            session.stop(); await { session.snapshot().state == ShellSession.State.STOPPED }
            session.clearOutput(); session.start(); await { session.snapshot().state == ShellSession.State.READY }
            session.submit("printf new-generation")
            await { session.snapshot().output.contains("new-generation") }
            assertFalse(session.snapshot().output.contains("stale-output"))
        }
    }
    @Test fun stopActuallyReapsTheRunningSleepChild() {
        shell().use { session ->
            session.start(); await { session.snapshot().state == ShellSession.State.READY }
            session.submit("sleep 30 & printf 'child-pid=%s\\n' \"${'$'}!\"; wait")
            val pattern=Regex("child-pid=([0-9]+)")
            await { pattern.find(session.snapshot().output) != null }
            val pid=pattern.find(session.snapshot().output)!!.groupValues[1].toLong()
            val handleType=Class.forName("java.lang.ProcessHandle")
            val optional=handleType.getMethod("of",java.lang.Long.TYPE).invoke(null,pid) as java.util.Optional<*>
            assertTrue(optional.isPresent)
            val handle=optional.get()
            assertTrue(handleType.getMethod("isAlive").invoke(handle) as Boolean)
            session.stop(); await { session.snapshot().state == ShellSession.State.STOPPED }
            await { !(handleType.getMethod("isAlive").invoke(handle) as Boolean) }
        }
    }
    @Test fun procIdentityParserHandlesParenthesesAndRejectsWrongOrMalformedPid() {
        val stat = "123 (bash (worker)) S 70 " + (5..21).joinToString(" ") { "0" } + " 991 0"
        val identity = ProcessTree.parse(123, stat)!!
        assertEquals(123, identity.pid); assertEquals(70, identity.parentPid); assertEquals("991", identity.started)
        assertNull(ProcessTree.parse(124, stat)); assertNull(ProcessTree.parse(123, "broken"))
    }
    @Test fun descendantsAreChildFirstAndExcludeUnrelatedAndReusedRoot() {
        val root = ProcessTree.Identity(10, 1, "a")
        val tree = listOf(root, ProcessTree.Identity(11, 10, "b"), ProcessTree.Identity(12, 11, "c"), ProcessTree.Identity(99, 1, "x"))
        assertEquals(listOf(12, 11), ProcessTree.descendants(root, tree).map { it.pid })
        assertTrue(ProcessTree.descendants(root.copy(started="old"), tree).isEmpty())
    }
}
