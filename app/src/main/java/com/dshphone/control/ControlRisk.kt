package com.dshphone.control

/** Unknown buttons and all free-coordinate gestures need native confirmation. */
object ControlRisk {
    private val commit = Regex("发送|发表|发布|提交|确认|确定|购买|支付|付款|转账|删除|清空|移除|卸载|授权|允许|登录|退出|send|post|publish|submit|confirm|buy|pay|purchase|transfer|delete|remove|clear|uninstall|allow|authorize|log.?in|log.?out", RegexOption.IGNORE_CASE)
    private val navigation = Regex("^(搜索|查找|返回|后退|下一页|上一页|菜单|展开|收起|关闭|取消|首页|主页|search|back|next|previous|menu|expand|collapse|close|cancel|home)$", RegexOption.IGNORE_CASE)
    fun needsConfirmation(action: String, label: String): Boolean = when (action) {
        "tap", "swipe", "long_press", "long_click" -> true
        "click" -> commit.containsMatchIn(label) || !navigation.matches(label.trim())
        else -> false
    }
}
