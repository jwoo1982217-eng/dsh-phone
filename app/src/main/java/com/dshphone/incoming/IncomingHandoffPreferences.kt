package com.dshphone.incoming

internal class IncomingHandoffPreferences(private val store: Store) {
    interface Store { fun read(): String?; fun write(value: String): Boolean }
    fun mode() = IncomingHandoffMode.fromStored(store.read())
    fun select(mode: IncomingHandoffMode): Boolean = store.write(mode.stored)
}
