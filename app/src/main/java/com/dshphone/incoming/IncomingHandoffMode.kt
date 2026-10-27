package com.dshphone.incoming

internal enum class IncomingHandoffMode(val stored: String) {
    ATTACH_CURRENT("attach-current"), TEMPORARY_WORKSPACE("temporary-workspace");
    companion object { fun fromStored(value: String?): IncomingHandoffMode = values().firstOrNull { it.stored == value } ?: ATTACH_CURRENT }
}
