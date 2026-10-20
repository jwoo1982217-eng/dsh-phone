package com.dshphone.control

import android.accessibilityservice.AccessibilityService
import android.graphics.Bitmap
import android.graphics.Rect
import android.util.Base64
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import kotlin.math.roundToInt

/** Crop to the authorized App bounds; limit both encoded size and raster dimensions. */
object PhoneScreenshot {
    @android.annotation.TargetApi(30)
    fun encode(result: AccessibilityService.ScreenshotResult, bounds: Rect): JSONObject {
        val hardware = Bitmap.wrapHardwareBuffer(result.hardwareBuffer, result.colorSpace) ?: error("截图像素不可用")
        var image: Bitmap? = null
        try {
            val area = Rect(bounds); check(area.intersect(0, 0, hardware.width, hardware.height) && !area.isEmpty) { "App 截图范围无效" }
            val copied = hardware.copy(Bitmap.Config.ARGB_8888, false) ?: error("截图复制失败")
            try { image = Bitmap.createBitmap(copied, area.left, area.top, area.width(), area.height()) }
            finally { if (image !== copied) copied.recycle() }
            val scale = minOf(1.0, 1280.0 / maxOf(area.width(), area.height()))
            if (scale < 1) {
                val original = image!!
                image = Bitmap.createScaledBitmap(original, (area.width() * scale).roundToInt().coerceAtLeast(1), (area.height() * scale).roundToInt().coerceAtLeast(1), true)
                if (image !== original) original.recycle()
            }
            val out = ByteArrayOutputStream()
            for (quality in listOf(75, 55, 35)) { out.reset(); check(image!!.compress(Bitmap.CompressFormat.JPEG, quality, out)) { "截图编码失败" }; if (out.size() <= 160 * 1024) break }
            check(out.size() <= 160 * 1024) { "截图过大，请改用 read 读取界面" }
            return JSONObject().put("image", JSONObject().put("mediaType", "image/jpeg").put("base64", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)))
                .put("imageWidth", image!!.width).put("imageHeight", image!!.height).put("screenWidth", area.width()).put("screenHeight", area.height())
                .put("originX", area.left).put("originY", area.top).put("hint", "坐标使用原屏幕像素；图片坐标需按 screenWidth/imageWidth、screenHeight/imageHeight 缩放后加 originX/originY")
        } finally { image?.recycle(); hardware.recycle() }
    }
}
