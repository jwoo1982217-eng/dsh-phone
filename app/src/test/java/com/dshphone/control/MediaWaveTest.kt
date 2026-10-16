package com.dshphone.control

import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MediaWaveTest {
    private fun wave(samples: Int, silent: Boolean = false): ByteArray {
        val b = ByteBuffer.allocate(44 + samples * 2).order(ByteOrder.LITTLE_ENDIAN)
        b.put("RIFF".toByteArray()).putInt(b.capacity() - 8).put("WAVEfmt ".toByteArray())
        b.putInt(16).putShort(1).putShort(1).putInt(16000).putInt(32000).putShort(2).putShort(16)
        b.put("data".toByteArray()).putInt(samples * 2)
        repeat(samples) { b.putShort(if (silent) 0 else if (it % 2 == 0) 1000 else -1000) }
        return b.array()
    }
    private fun audible(bytes: ByteArray): Boolean {
        val f = File.createTempFile("tts-output-", ".wav")
        return try { f.writeBytes(bytes); MediaWave.isAudible(f) } finally { f.delete() }
    }
    @Test fun realLenovoEmptyCallbackIsRejected() {
        assertFalse(audible(wave(1, silent = true)))
    }
    @Test fun pcmSpeechAndMinimumDurationAreAccepted() {
        assertTrue(audible(wave(16000)))
        assertTrue(audible(wave(1600)))
        assertFalse(audible(wave(1599)))
    }
    @Test fun silentAndTruncatedAudioCannotBePublished() {
        assertFalse(audible(wave(16000, silent = true)))
        assertFalse(audible(wave(16000).copyOf(100)))
        assertFalse(audible(ByteArray(60)))
    }
}
