package com.dshphone.control

import java.io.File
import java.io.RandomAccessFile

/** Reject empty TTS callbacks, truncated WAVs and silent PCM before publishing. */
internal object MediaWave {
    fun isAudible(file: File): Boolean = runCatching {
        RandomAccessFile(file, "r").use { input ->
            fun tag(): String = String(ByteArray(4).also { input.readFully(it) }, Charsets.US_ASCII)
            fun u16(): Int = input.readUnsignedByte() or (input.readUnsignedByte() shl 8)
            fun u32(): Long = u16().toLong() or (u16().toLong() shl 16)
            val length = input.length()
            if (length < 44 || length > 64L * 1024 * 1024 || tag() != "RIFF") return false
            val declared = u32() + 8
            if (declared > length || declared < 44 || tag() != "WAVE") return false
            var sampleRate = 0L
            var blockAlign = 0
            var bits = 0
            var format = 0
            while (input.filePointer + 8 <= declared) {
                val kind = tag()
                val size = u32()
                val start = input.filePointer
                if (size > declared - start) return false
                if (kind == "fmt ") {
                    if (size < 16) return false
                    format = u16()
                    val channels = u16()
                    sampleRate = u32()
                    u32()
                    blockAlign = u16()
                    bits = u16()
                    if (format !in listOf(1, 3) || channels !in 1..2 || sampleRate !in 8000..192000 || bits !in listOf(8, 16, 24, 32) || blockAlign != channels * bits / 8 || format == 3 && bits != 32) return false
                } else if (kind == "data") {
                    if (blockAlign == 0 || size < sampleRate * blockAlign / 10 || size % blockAlign != 0L) return false
                    val buffer = ByteArray(8192)
                    var remaining = size
                    var nonSilent = false
                    while (remaining > 0) {
                        val count = minOf(buffer.size.toLong(), remaining).toInt()
                        input.readFully(buffer, 0, count)
                        val silence = if (format == 1 && bits == 8) 128 else 0
                        if ((0 until count).any { (buffer[it].toInt() and 255) != silence }) nonSilent = true
                        remaining -= count
                    }
                    return nonSilent
                }
                input.seek(start + size + size % 2)
            }
            false
        }
    }.getOrDefault(false)
}
