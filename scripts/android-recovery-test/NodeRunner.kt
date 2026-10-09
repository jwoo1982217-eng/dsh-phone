package com.dshphone

import android.content.Context
import java.io.File

/** No engine starts in the disposable recovery verification application. */
object NodeRunner {
    const val ASSET_VERSION = "test-assets"
    fun binJs(ctx: Context) = File(ctx.filesDir, "tree/node_modules/@deepseek-ai/dsh/lib/bin.js")
}
