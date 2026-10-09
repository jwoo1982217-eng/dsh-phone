package com.dshphone

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ColorSpace
import android.graphics.ImageDecoder
import android.media.ExifInterface
import android.net.LocalServerSocket
import android.os.Process
import java.util.UUID
import java.util.concurrent.Executors
import java.io.InputStream
import java.io.DataInputStream
import android.util.Base64
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import kotlin.math.floor
import kotlin.math.min

/** Private Unix socket bridge. Only the same app UID can submit image bytes. */
object AndroidImageProcessor {
    private var socketName: String? = null
    @Synchronized fun start(): String {
        socketName?.let { return it }
        val name = "dsh-images-" + UUID.randomUUID().toString()
        val server = LocalServerSocket(name)
        val workers = Executors.newFixedThreadPool(2) { runnable -> Thread(runnable, "dsh-image-worker").apply { isDaemon = true } }
        Thread({
            while (true) {
                val socket = runCatching { server.accept() }.getOrNull() ?: break
                workers.execute {
                    runCatching { socket.use {
                        if (it.peerCredentials.uid != Process.myUid()) return@execute
                        it.soTimeout = 30000
                        val result = process(it.inputStream)
                        it.outputStream.write(result.toString().toByteArray(Charsets.UTF_8))
                    } }
                }
            }
        }, "dsh-image-listener").apply { isDaemon = true; start() }
        socketName = name
        return name
    }
    private fun process(stream: InputStream): JSONObject {
        return try {
            val wire = DataInputStream(stream)
            val length = wire.readInt()
            check(length in 1..(32 * 1024 * 1024)) { "Image input exceeds 24 MB" }
            val input = ByteArray(length); wire.readFully(input)
            val request = JSONObject(String(input, Charsets.UTF_8))
            val data = Base64.decode(request.getString("data"), Base64.NO_WRAP)
            check(data.isNotEmpty() && data.size <= 24 * 1024 * 1024) { "Invalid image byte count" }
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(data, 0, data.size, bounds)
            val format = when (bounds.outMimeType) {
                "image/png" -> "png"
                "image/jpeg" -> "jpeg"
                "image/webp" -> "webp"
                "image/gif" -> "gif"
                else -> error("Unsupported or malformed image data")
            }
            check(bounds.outWidth > 0 && bounds.outHeight > 0 && bounds.outWidth <= 8192 && bounds.outHeight <= 8192 &&
                bounds.outWidth.toLong() * bounds.outHeight <= 64000000L) { "Image dimensions exceed admission limits" }
            // ImageDecoder refuses incomplete data and applies EXIF orientation.
            var bitmap = ImageDecoder.decodeBitmap(ImageDecoder.createSource(ByteBuffer.wrap(data))) { decoder, _, _ ->
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                decoder.setTargetColorSpace(ColorSpace.get(ColorSpace.Named.SRGB))
                decoder.setOnPartialImageListener { false }
            }
            if (bitmap.config != Bitmap.Config.ARGB_8888) {
                val converted = bitmap.copy(Bitmap.Config.ARGB_8888, false)
                bitmap.recycle(); bitmap = converted
            }
            try {
                val metadata = JSONObject().put("format", format).put("width", bounds.outWidth).put("height", bounds.outHeight)
                    .put("pages", if (format == "gif") 2 else 1).put("depth", if (format == "png" && data.size > 24 && data[24].toInt() == 16) "ushort" else "uchar")
                    .put("space", "srgb").put("hasAlpha", bitmap.hasAlpha())
                val orientation = runCatching { ExifInterface(ByteArrayInputStream(data)).getAttributeInt(ExifInterface.TAG_ORIENTATION, 1) }.getOrDefault(1)
                if (orientation in 2..8) metadata.put("orientation", orientation)
                if (hasMetadata(data, format)) metadata.put("hasProfile", true)
                val operation = request.optString("operation", "metadata")
                val result = JSONObject().put("ok", true).put("metadata", metadata)
                if (operation != "metadata") {
                    val width = request.optInt("width", 0)
                    val height = request.optInt("height", 0)
                    check(width in 0..8192 && height in 0..8192) { "Invalid resize dimensions" }
                    if (width > 0 || height > 0) {
                        var scale = min(if (width > 0) width.toDouble() / bitmap.width else Double.POSITIVE_INFINITY,
                            if (height > 0) height.toDouble() / bitmap.height else Double.POSITIVE_INFINITY)
                        if (request.optBoolean("withoutEnlargement", false)) scale = min(1.0, scale)
                        val w = floor(bitmap.width * scale).toInt().coerceAtLeast(1)
                        val h = floor(bitmap.height * scale).toInt().coerceAtLeast(1)
                        check(w.toLong() * h <= 64000000L) { "Resize exceeds pixel limit" }
                        if (w != bitmap.width || h != bitmap.height) {
                            val resized = Bitmap.createScaledBitmap(bitmap, w, h, true)
                            if (resized !== bitmap) { bitmap.recycle(); bitmap = resized }
                        }
                    }
                    val bytes = if (operation == "raw") {
                        ByteBuffer.allocate(bitmap.byteCount).also { bitmap.copyPixelsToBuffer(it) }.array()
                    } else {
                        check(operation in listOf("jpeg", "webp", "png")) { "Unsupported encoding operation" }
                        val quality = request.optInt("quality", 85)
                        check(quality in 1..100) { "Invalid image quality" }
                        val output = ByteArrayOutputStream()
                        val encoding = when (operation) {
                            "jpeg" -> Bitmap.CompressFormat.JPEG
                            "webp" -> Bitmap.CompressFormat.WEBP
                            else -> Bitmap.CompressFormat.PNG
                        }
                        check(bitmap.compress(encoding, quality, output)) { "Image encoding failed" }
                        stripMetadata(output.toByteArray(), operation)
                    }
                    result.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP))
                        .put("info", JSONObject().put("width", bitmap.width).put("height", bitmap.height).put("channels", 4).put("size", bytes.size))
                }
                result
            } finally { bitmap.recycle() }
        } catch (error: Throwable) {
            JSONObject().put("ok", false).put("error", error.message ?: error.javaClass.simpleName)
        }
    }

    // The decoded pixels are already sRGB and oriented. Android encoders can
    // add an ICC segment; drop ancillary metadata to match DSH normalization.
    private fun stripMetadata(bytes: ByteArray, format: String): ByteArray {
        val output = ByteArrayOutputStream()
        if (format == "jpeg") {
            output.write(bytes, 0, 2)
            var offset = 2
            while (offset + 4 <= bytes.size && bytes[offset].toInt() and 255 == 255) {
                val marker = bytes[offset + 1].toInt() and 255
                if (marker == 218 || marker == 217) { output.write(bytes, offset, bytes.size - offset); return output.toByteArray() }
                val size = (bytes[offset + 2].toInt() and 255) * 256 + (bytes[offset + 3].toInt() and 255)
                check(size >= 2 && size <= bytes.size - offset - 2) { "Invalid encoded JPEG" }
                if (marker !in listOf(225, 226, 237, 254)) output.write(bytes, offset, size + 2)
                offset += size + 2
            }
        } else if (format == "webp") {
            output.write(bytes, 0, 12)
            var offset = 12
            while (offset + 8 <= bytes.size) {
                val type = String(bytes, offset, 4, Charsets.US_ASCII)
                val size = ByteBuffer.wrap(bytes, offset + 4, 4).order(java.nio.ByteOrder.LITTLE_ENDIAN).int
                check(size >= 0 && size <= bytes.size - offset - 8) { "Invalid encoded WebP" }
                if (type !in listOf("EXIF", "XMP ", "ICCP")) {
                    val chunk = bytes.copyOfRange(offset, offset + 8 + size + size % 2)
                    if (type == "VP8X" && size >= 10) chunk[8] = (chunk[8].toInt() and 0xD3).toByte()
                    output.write(chunk)
                }
                offset += 8 + size + size % 2
            }
            return output.toByteArray().also { ByteBuffer.wrap(it, 4, 4).order(java.nio.ByteOrder.LITTLE_ENDIAN).putInt(it.size - 8) }
        } else if (format == "png") {
            output.write(bytes, 0, 8)
            var offset = 8
            while (offset + 12 <= bytes.size) {
                val size = ByteBuffer.wrap(bytes, offset, 4).int
                check(size >= 0 && size <= bytes.size - offset - 12) { "Invalid encoded PNG" }
                val type = String(bytes, offset + 4, 4, Charsets.US_ASCII)
                if (type !in listOf("eXIf", "iCCP", "iTXt", "tEXt", "zTXt")) output.write(bytes, offset, size + 12)
                offset += size + 12
            }
            return output.toByteArray()
        }
        return bytes
    }

    private fun hasMetadata(bytes: ByteArray, format: String): Boolean {
        if (format == "png") {
            var offset = 8
            while (offset + 12 <= bytes.size) {
                val size = ByteBuffer.wrap(bytes, offset, 4).int
                if (size < 0 || size > bytes.size - offset - 12) return true
                val type = String(bytes, offset + 4, 4, Charsets.US_ASCII)
                if (type in listOf("eXIf", "iCCP", "iTXt", "tEXt", "zTXt")) return true
                offset += size + 12
            }
        } else if (format == "webp") {
            var offset = 12
            while (offset + 8 <= bytes.size) {
                val type = String(bytes, offset, 4, Charsets.US_ASCII)
                if (type in listOf("EXIF", "XMP ", "ICCP")) return true
                val size = ByteBuffer.wrap(bytes, offset + 4, 4).order(java.nio.ByteOrder.LITTLE_ENDIAN).int
                if (size < 0 || size > bytes.size - offset - 8) return true
                offset += 8 + size + size % 2
            }
        } else if (format == "jpeg") {
            var offset = 2
            while (offset + 4 <= bytes.size && bytes[offset].toInt() and 255 == 255) {
                val marker = bytes[offset + 1].toInt() and 255
                if (marker in listOf(225, 226, 237, 254)) return true
                if (marker == 218 || marker == 217) break
                val size = (bytes[offset + 2].toInt() and 255) * 256 + (bytes[offset + 3].toInt() and 255)
                if (size < 2 || size > bytes.size - offset - 2) return true
                offset += size + 2
            }
        }
        return false
    }
}
