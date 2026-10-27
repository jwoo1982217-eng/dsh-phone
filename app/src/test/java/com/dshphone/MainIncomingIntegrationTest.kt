package com.dshphone

import android.app.Application
import android.content.Intent
import android.net.Uri
import android.os.Looper
import android.webkit.ValueCallback
import android.webkit.WebView
import com.dshphone.incoming.AndroidIncomingPreferences
import com.dshphone.incoming.IncomingHandoffMode
import java.io.File
import java.util.ArrayDeque
import java.util.concurrent.ExecutorService
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import org.robolectric.shadows.ShadowAlertDialog

/** Real MainActivity entrypoints; only WebView's asynchronous renderer reply is controlled. */
@RunWith(org.robolectric.RobolectricTestRunner::class)
@Config(sdk=[35],application=Application::class)
@LooperMode(LooperMode.Mode.PAUSED)
class MainIncomingIntegrationTest {
    class Renderer(activity:MainActivity):WebView(activity) {
        var page="http://127.0.0.1:3080/chat"
        val scripts=mutableListOf<String>()
        val callbacks=mutableListOf<ValueCallback<String>>()
        override fun getUrl()=page
        override fun evaluateJavascript(script:String,callback:ValueCallback<String>?) {
            super.evaluateJavascript(script,null)
            scripts.add(script);if(callback!=null)callbacks.add(callback)
        }
        fun reply(value:String,index:Int=callbacks.lastIndex) { callbacks[index].onReceiveValue(value) }
    }
    private lateinit var a:MainActivity
    private lateinit var view:Renderer
    private fun field(name:String)=MainActivity::class.java.getDeclaredField(name).apply{isAccessible=true}
    private fun get(name:String)=field(name).get(a)
    private fun set(name:String,value:Any?)=field(name).set(a,value)
    private fun invoke(name:String,vararg args:Any?):Any? {
        val method=MainActivity::class.java.declaredMethods.single{it.name==name&&it.parameterCount==args.size}.apply{isAccessible=true}
        return method.invoke(a,*args)
    }
    @Suppress("UNCHECKED_CAST") private fun batches()=get("incomingBatches") as ArrayDeque<Any>
    private fun batchField(batch:Any,name:String)=batch.javaClass.getDeclaredField(name).apply{isAccessible=true}
    private fun batchGet(batch:Any,name:String)=batchField(batch,name).get(batch)
    private fun batchSet(batch:Any,name:String,value:Any?)=batchField(batch,name).set(batch,value)
    private fun uploadedPath(name:String) = File(NodeRunner.homeDir(a),"uploads/chat-files/"+"a".repeat(32)+"/content/"+name).absolutePath
    private fun preferences(mode:IncomingHandoffMode) { assertTrue(AndroidIncomingPreferences(a).select(mode)) }
    private fun share(intent:Intent) { invoke("onNewIntent",intent) }
    private fun fileShare(name:String="one")=Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_STREAM,Uri.parse("content://synthetic/$name"))
    private fun refs(mode:IncomingHandoffMode=IncomingHandoffMode.TEMPORARY_WORKSPACE):Pair<Any,String?> {
        preferences(mode);share(fileShare());val batch=batches().first
        @Suppress("UNCHECKED_CAST") (batchGet(batch,"uris") as ArrayDeque<Uri>).clear()
        val file=JSONObject().put("path",uploadedPath("a.txt")).put("name","a.txt").put("size",3).put("sha256","a".repeat(64))
        @Suppress("UNCHECKED_CAST") (batchGet(batch,"files") as MutableList<JSONObject>).add(file)
        val target=if(mode==IncomingHandoffMode.TEMPORARY_WORKSPACE)"session-incoming-${batchGet(batch,"id")}" else null
        batchSet(batch,"targetSession",target)
        set("incomingReferences",JSONArray().put(invoke("incomingReference",file)).toString());set("lastLoadedOk",true)
        return batch to target
    }
    private fun append(text:String,target:String?,attempt:Int=0,done:()->Unit={}) { invoke("appendIncomingText",text,target,attempt,done) }
    @Before fun setup() {
        a=Robolectric.buildActivity(MainActivity::class.java).get();view=Renderer(a);set("webView",view)
        a.getSharedPreferences("incoming-handoff",0).edit().clear().commit()
    }
    @After fun cleanup() {
        ShadowAlertDialog.getLatestAlertDialog()?.dismiss()
        set("destroyed",true);(get("readinessWorker") as ExecutorService).shutdownNow()
        (get("handler") as android.os.Handler).removeCallbacksAndMessages(null);view.destroy()
    }
    @Test fun everyShareSnapshotsModeAndLaterShareCannotMergeIntoPreviousBatch() {
        share(fileShare("first"));val first=batches().first
        preferences(IncomingHandoffMode.TEMPORARY_WORKSPACE);share(fileShare("second"))
        assertEquals(2,batches().size);val second=batches().last
        assertEquals(IncomingHandoffMode.ATTACH_CURRENT,batchGet(first,"mode"));assertEquals(IncomingHandoffMode.TEMPORARY_WORKSPACE,batchGet(second,"mode"))
        assertNotEquals(batchGet(first,"id"),batchGet(second,"id"));assertNotSame(batchGet(first,"uris"),batchGet(second,"uris"))
    }
    @Test fun temporaryModeRejectsOver16DistinctFilesButOldAttachModeKeepsExistingCapacity() {
        fun many()=Intent(Intent.ACTION_SEND_MULTIPLE).putParcelableArrayListExtra(Intent.EXTRA_STREAM,ArrayList((1..17).map{Uri.parse("content://synthetic/$it")}))
        preferences(IncomingHandoffMode.TEMPORARY_WORKSPACE);share(many());assertTrue(batches().isEmpty())
        preferences(IncomingHandoffMode.ATTACH_CURRENT);share(many());assertEquals(17,(batchGet(batches().first,"uris") as ArrayDeque<*>).size)
    }
    @Test fun temporary16LimitCountsDistinctUrisAndBatchQueueIsBounded() {
        preferences(IncomingHandoffMode.TEMPORARY_WORKSPACE)
        val uri=Uri.parse("content://synthetic/repeated")
        share(Intent(Intent.ACTION_SEND_MULTIPLE).putParcelableArrayListExtra(Intent.EXTRA_STREAM,ArrayList((1..20).map{uri})))
        assertEquals(1,(batchGet(batches().first,"uris") as ArrayDeque<*>).size)
        for(i in 1..20)share(fileShare("batch$i"));assertEquals(16,batches().size)
    }
    @Test fun onlyTrustedLocalMainPageCanReceiveFilesOrText() {
        refs();set("lastLoadedOk",true)
        for(url in listOf("https://example.org/","http://127.0.0.1:3081/","http://user@127.0.0.1:3080/","https://127.0.0.1:3080/")) {
            view.page=url;invoke("consumeIncomingFilesIfReady");append("text",null);assertTrue(view.scripts.isEmpty())
        }
        view.page="http://127.0.0.1:3080/chat";set("remoteMode",true);invoke("deliverIncomingReferences");assertTrue(view.scripts.isEmpty())
    }
    @Test fun temporaryReferencesWaitForExactSessionAndRemainOriginalChatFileHandles() {
        val (_,target)=refs();invoke("deliverIncomingReferences")
        val script=shadowOf(view).lastEvaluatedJavascript
        assertTrue(script.contains(target!!));assertTrue(script.contains("__dshPhoneOpenIncomingSession"));assertTrue(script.replace("\\/","/").contains("uploads/chat-files/"))
        assertTrue(script.contains("data-conversation-session"));assertFalse(script.contains(".click("));assertFalse(script.contains(".submit("))
    }
    @Test fun explicitNavigationFailurePreservesBatchReferencesForSameBatchRetry() {
        val (batch,_)=refs();val original=get("incomingReferences");invoke("deliverIncomingReferences");view.reply("{\"error\":\"synthetic navigation failed\"}")
        assertEquals(original,get("incomingReferences"));assertSame(batch,batches().first);assertEquals(true,get("incomingPaused"))
        val dialog=ShadowAlertDialog.getLatestAlertDialog();assertNotNull(dialog);dialog.getButton(android.app.AlertDialog.BUTTON_POSITIVE).performClick();shadowOf(Looper.getMainLooper()).idle()
        assertEquals(false,get("incomingPaused"));assertSame(batch,batches().first)
    }
    @Test fun aMissingComposerTimeoutRetainsReferencesAndDoesNotAutomaticallySend() {
        val (batch,_)=refs();set("incomingReferenceAttempt",59);invoke("deliverIncomingReferences");view.reply("false")
        assertSame(batch,batches().first);assertNotNull(get("incomingReferences"));assertEquals(true,get("incomingPaused"))
        assertFalse(view.scripts.any{it.contains(".submit(")||it.contains(".click(")})
    }
    @Test fun oldRendererLateSuccessCannotAcknowledgeOrConsumePendingBatch() {
        val (batch,_)=refs();invoke("deliverIncomingReferences");val replacement=Renderer(a);set("webView",replacement)
        try { view.reply("true");assertNotNull("Late callback from a replaced WebView lost pending references",get("incomingReferences"));assertSame(batch,batches().first) } finally {replacement.destroy()}
    }
    @Test fun navigationAwayBeforeReplyDoesNotDiscardPendingReferences() {
        refs();invoke("deliverIncomingReferences");view.page="https://foreign.example/";view.reply("true")
        assertNotNull("Old local-page result must not acknowledge after external navigation",get("incomingReferences"))
    }
    @Test fun staleTextCallbackAfterDestructionCannotCompleteTheBatch() {
        set("lastLoadedOk",true);var completed=false;append("synthetic text",null,done={completed=true});set("destroyed",true);view.reply("true")
        assertFalse("Destroyed Activity completed a stale text delivery",completed)
    }
    @Test fun unsuccessfulTextDeliveryMustRemainRetryableRatherThanCompleting() {
        set("lastLoadedOk",true);var completed=false;append("synthetic text",null,60){completed=true};view.reply("false")
        assertFalse("Text delivery failure called the success/removal continuation",completed)
    }
    @Test fun choosingModeDoesNotSilentlyChangeItUntilExplicitSave() {
        invoke("chooseIncomingMode");val dialog=ShadowAlertDialog.getLatestAlertDialog();val box=shadowOf(dialog).view as android.widget.LinearLayout
        val choices=box.getChildAt(1) as android.widget.RadioGroup;choices.check(2)
        assertEquals(IncomingHandoffMode.ATTACH_CURRENT,AndroidIncomingPreferences(a).mode());dialog.getButton(android.app.AlertDialog.BUTTON_NEGATIVE).performClick();shadowOf(Looper.getMainLooper()).idle()
        assertEquals(IncomingHandoffMode.ATTACH_CURRENT,AndroidIncomingPreferences(a).mode())
        invoke("chooseIncomingMode");val saved=ShadowAlertDialog.getLatestAlertDialog();val savedChoices=(shadowOf(saved).view as android.widget.LinearLayout).getChildAt(1) as android.widget.RadioGroup
        savedChoices.check(2);saved.getButton(android.app.AlertDialog.BUTTON_POSITIVE).performClick();shadowOf(Looper.getMainLooper()).idle();assertEquals(IncomingHandoffMode.TEMPORARY_WORKSPACE,AndroidIncomingPreferences(a).mode())
    }
    @Test fun actualUploadAdmissionFailureKeepsSameUriAndBatchForRetryWithoutNetwork() {
        share(fileShare("missing-login"));val batch=batches().first;val originalId=batchGet(batch,"id")
        android.webkit.CookieManager.getInstance().removeAllCookies(null);set("lastLoadedOk",true)
        invoke("consumeIncomingFilesIfReady")
        (get("readinessWorker") as ExecutorService).submit{}.get(5,java.util.concurrent.TimeUnit.SECONDS)
        shadowOf(Looper.getMainLooper()).idle()
        assertSame(batch,batches().first);assertEquals(originalId,batchGet(batch,"id"));assertEquals(1,(batchGet(batch,"uris") as ArrayDeque<*>).size)
        assertTrue((batchGet(batch,"files") as List<*>).isEmpty());assertEquals(true,get("incomingPaused"));assertTrue(view.scripts.isEmpty())
    }
    private fun documentRestart() {
        set("modeButton",android.widget.TextView(a))
        val production=invoke("createMainWebView") as WebView
        val client=production.webViewClient
        view.webViewClient=client
        try { client.onPageStarted(view,view.page,null) } finally { production.destroy() }
    }
    @Test fun sameUrlNewDocumentCannotAcknowledgeOldPageOrClearNewDispatch() {
        refs();invoke("deliverIncomingReferences");val first=view.callbacks.lastIndex
        documentRestart();invoke("deliverIncomingReferences");val newer=view.callbacks.lastIndex
        assertNotEquals(first,newer);assertEquals(true,get("incomingDeliveryInFlight"))
        view.reply("false",first);assertEquals("Old reply cleared the new delivery lease",true,get("incomingDeliveryInFlight"));assertNotNull(get("incomingReferences"))
        view.reply("true",newer);assertNull(get("incomingReferences"));assertTrue(batches().isEmpty())
    }
    @Test fun incomingTextRemainsInBatchUntilExactlyOneSuccessfulAcknowledgment() {
        share(Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_TEXT,"pending share text"));val batch=batches().first;set("lastLoadedOk",true)
        invoke("consumeIncomingFilesIfReady");assertEquals("pending share text",batchGet(batch,"text"));val count=view.scripts.size
        invoke("consumeIncomingFilesIfReady");assertEquals("Parallel consume duplicated the same text dispatch",count,view.scripts.size)
        view.reply("true");assertTrue(batches().isEmpty());view.reply("true");assertTrue(batches().isEmpty())
    }
    @Test fun recreationKeepsBatchIdentityUploadedProgressAndDoesNotRecaptureAcknowledgedIntent() {
        preferences(IncomingHandoffMode.TEMPORARY_WORKSPACE)
        val intent=Intent(Intent.ACTION_SEND_MULTIPLE).putParcelableArrayListExtra(Intent.EXTRA_STREAM,arrayListOf(Uri.parse("content://synthetic/rotation"),Uri.parse("content://synthetic/next")))
        val first=Robolectric.buildActivity(MainActivity::class.java,intent).create();val original=first.get()
        @Suppress("UNCHECKED_CAST") val oldQueue=field("incomingBatches").get(original) as ArrayDeque<Any>
        assertEquals(1,oldQueue.size);val batch=oldQueue.first;val id=batchGet(batch,"id")
        val file=JSONObject().put("path",uploadedPath("already.txt")).put("name","already.txt").put("size",1)
        @Suppress("UNCHECKED_CAST") (batchGet(batch,"files") as MutableList<JSONObject>).add(file)
        batchSet(batch,"targetSession","session-incoming-$id");batchSet(batch,"text","retained text")
        @Suppress("UNCHECKED_CAST") (batchGet(batch,"uris") as ArrayDeque<Uri>).removeFirst()
        val pending=JSONArray().put(invoke("incomingReference",file)).toString()
        field("incomingReferences").set(original,pending)
        val saved=android.os.Bundle();first.saveInstanceState(saved).destroy()
        val second=Robolectric.buildActivity(MainActivity::class.java,intent).create(saved)
        try {
            @Suppress("UNCHECKED_CAST") val restored=field("incomingBatches").get(second.get()) as ArrayDeque<Any>
            assertEquals("A single explicit share was recaptured or lost",1,restored.size)
            assertEquals("Rotation minted a new temporary-session identity",id,batchGet(restored.first,"id"))
            assertEquals("retained text",batchGet(restored.first,"text"));assertEquals(pending,field("incomingReferences").get(second.get()))
            assertEquals("session-incoming-$id",batchGet(restored.first,"targetSession"));assertEquals(1,(batchGet(restored.first,"files") as List<*>).size)
            val remaining=batchGet(restored.first,"uris") as ArrayDeque<*>
            assertEquals(1,remaining.size);assertEquals("content://synthetic/next",remaining.first.toString())
            restored.clear();field("incomingReferences").set(second.get(),null)
            val consumed=android.os.Bundle();second.saveInstanceState(consumed).destroy()
            val third=Robolectric.buildActivity(MainActivity::class.java,intent).create(consumed)
            try { assertTrue("Already-acknowledged original Intent was replayed",(field("incomingBatches").get(third.get()) as ArrayDeque<*>).isEmpty()) } finally { third.destroy() }
        } finally { if(!field("destroyed").getBoolean(second.get())) second.destroy() }
    }
    private fun checkpoint():Pair<android.os.Bundle,File> {
        val state=android.os.Bundle();invoke("saveIncomingState",state)
        val id=state.getString("dsh.incoming.checkpoint") ?: error("No checkpoint created")
        return state to File(a.cacheDir,"incoming-handoff/$id.json")
    }
    @Test fun savedBinderStateHasOnlyOpaqueCheckpointAndRestoreWaitsForExplicitRetry() {
        val (batch,_)=refs();val (state,file)=checkpoint()
        assertEquals(setOf("dsh.incoming.checkpoint"),state.keySet());assertEquals(32,state.getString("dsh.incoming.checkpoint")!!.length)
        assertFalse(state.toString().contains("uploads/chat-files"));batches().clear();set("incomingReferences",null)
        assertEquals(true,invoke("restoreIncomingState",state));assertFalse(file.exists());assertEquals(batchGet(batch,"id"),batchGet(batches().first,"id"))
        invoke("consumeIncomingFilesIfReady");assertTrue(view.scripts.isEmpty());assertEquals(true,get("incomingPaused"))
    }
    @Test fun acknowledgedAttachmentsAreNotReinsertedByARecoveryCheckpoint() {
        refs(IncomingHandoffMode.ATTACH_CURRENT);invoke("deliverIncomingReferences");view.reply("true")
        assertTrue(batches().isEmpty());assertNull(get("incomingReferences"))
        val (state,file)=checkpoint();assertEquals(true,invoke("restoreIncomingState",state))
        assertFalse(file.exists());assertTrue(batches().isEmpty());assertNull(get("incomingReferences"))
    }
    @Test fun malformedOrUnknownModeCheckpointNeverFallsBackToAttachCurrent() {
        refs();val (state,file)=checkpoint();val original=JSONObject(file.readText())
        for(mode in listOf("future-unrecognized-mode","","attach-current")) {
            val invalid=JSONObject(original.toString());invalid.getJSONArray("queue").getJSONObject(0).put("mode",mode);file.writeText(invalid.toString());batches().clear();set("incomingReferences",null)
            assertEquals(true,invoke("restoreIncomingState",state));assertTrue("Unknown persisted mode was interpreted as consent",batches().isEmpty());assertEquals(true,get("incomingCaptureDone"))
        }
        file.writeText("{bad");assertEquals(true,invoke("restoreIncomingState",state));assertTrue(batches().isEmpty())
    }
    @Test fun duplicateIdentityInvalidUriAndMismatchedTargetRejectEntireRecovery() {
        refs();val (state,file)=checkpoint();val original=JSONObject(file.readText())
        val invalid=mutableListOf<JSONObject>()
        invalid.add(JSONObject(original.toString()).apply{getJSONArray("queue").put(JSONObject(getJSONArray("queue").getJSONObject(0).toString()))})
        invalid.add(JSONObject(original.toString()).apply{getJSONArray("queue").getJSONObject(0).put("target","session-incoming-"+"0".repeat(32))})
        invalid.add(JSONObject(original.toString()).apply{getJSONArray("queue").getJSONObject(0).getJSONArray("uris").put("https://foreign.invalid/file")})
        for(value in invalid) {
            file.writeText(value.toString());batches().clear();set("incomingReferences",null);assertEquals(true,invoke("restoreIncomingState",state));assertTrue("Invalid recovery was partially applied",batches().isEmpty())
        }
    }
    @Test fun missingCheckpointAndSaveFailureMarkersDoNotRecaptureOriginalShareIntent() {
        for(state in listOf(android.os.Bundle().apply{putString("dsh.incoming.checkpoint","e".repeat(32))},android.os.Bundle().apply{putBoolean("dsh.incoming.restoreFailed",true)})) {
            val c=Robolectric.buildActivity(MainActivity::class.java,fileShare("original")).create(state)
            try { assertTrue("Uncertain old Intent was recaptured",(field("incomingBatches").get(c.get()) as ArrayDeque<*>).isEmpty());assertTrue(field("incomingCaptureDone").getBoolean(c.get())) } finally {c.destroy()}
        }
    }
    @Test fun persistedUploadPathTraversalIsNotAcceptedAsAChatFileHandle() {
        refs();val (state,file)=checkpoint();val invalid=JSONObject(file.readText());invalid.getJSONArray("queue").getJSONObject(0).getJSONArray("files").getJSONObject(0).put("path",File(NodeRunner.homeDir(a),"uploads/chat-files/../../private.txt").absolutePath)
        file.writeText(invalid.toString());batches().clear();set("incomingReferences",null);invoke("restoreIncomingState",state)
        assertTrue("Prefix-only upload handle validation accepted traversal",batches().isEmpty())
    }
    @Test fun recoveryRefusesSymlinkedCheckpointDirectoryWithoutDeletingForeignFile() {
        val id="b".repeat(32);val directory=File(a.cacheDir,"incoming-handoff");val outside=java.nio.file.Files.createTempDirectory(a.cacheDir.toPath(),"foreign-state-").toFile();val victim=File(outside,"$id.json");victim.writeText("unowned synthetic bytes")
        assertFalse(directory.exists());java.nio.file.Files.createSymbolicLink(directory.toPath(),outside.toPath())
        try {
            val state=android.os.Bundle().apply{putString("dsh.incoming.checkpoint",id)};invoke("restoreIncomingState",state)
            assertTrue("Recovery deleted a file outside its non-symlink checkpoint directory",victim.exists());assertEquals("unowned synthetic bytes",victim.readText());assertTrue(batches().isEmpty())
        } finally {java.nio.file.Files.deleteIfExists(directory.toPath());outside.deleteRecursively()}
    }
    @Test fun saveRefusesSymlinkedCheckpointDirectoryWithoutOverwritingForeignFile() {
        share(fileShare());val id=get("incomingCheckpointId").toString();val directory=File(a.cacheDir,"incoming-handoff")
        val outside=java.nio.file.Files.createTempDirectory(a.cacheDir.toPath(),"foreign-save-").toFile();val victim=File(outside,"$id.json");victim.writeText("unowned original bytes")
        assertFalse(directory.exists());java.nio.file.Files.createSymbolicLink(directory.toPath(),outside.toPath())
        try {
            val state=android.os.Bundle();invoke("saveIncomingState",state)
            assertEquals("Save followed a directory symlink and replaced unowned data","unowned original bytes",victim.readText())
            assertTrue(state.getBoolean("dsh.incoming.restoreFailed"));assertFalse(state.containsKey("dsh.incoming.checkpoint"))
        } finally {java.nio.file.Files.deleteIfExists(directory.toPath());outside.deleteRecursively()}
    }
    @Test fun saveDoesNotFollowPreexistingTemporaryFileSymlink() {
        share(fileShare());val id=get("incomingCheckpointId").toString();val directory=File(a.cacheDir,"incoming-handoff").apply{mkdirs()}
        val victim=File.createTempFile("foreign-bytes-",".txt",a.cacheDir).apply{writeText("preserve original synthetic bytes")}
        val temporary=File(directory,"$id.tmp");java.nio.file.Files.createSymbolicLink(temporary.toPath(),victim.toPath())
        try {
            val state=android.os.Bundle();invoke("saveIncomingState",state)
            assertEquals("Save followed a preexisting temporary symlink","preserve original synthetic bytes",victim.readText())
        } finally {java.nio.file.Files.deleteIfExists(temporary.toPath());File(directory,"$id.json").delete();victim.delete()}
    }
    @Test fun captureDescriptorBoundMeasuresUtf8BytesNotOnlyCharacterCount() {
        share(Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_TEXT,"汉".repeat(180000)))
        assertTrue("A >512KiB UTF-8 descriptor bypassed the capture bound",batches().isEmpty())
    }
    @Test fun exportExactProductionGeneratedJavascriptForRealTwoComposerFixture() {
        val (_,target)=refs();val references=get("incomingReferences") as String;invoke("deliverIncomingReferences");val targetScript=shadowOf(view).lastEvaluatedJavascript
        set("incomingDeliveryInFlight",false);batchSet(batches().first,"targetSession",null);invoke("deliverIncomingReferences");val legacy=shadowOf(view).lastEvaluatedJavascript
        append("incoming text",target);val targetText=shadowOf(view).lastEvaluatedJavascript
        append("incoming text",null);val currentText=shadowOf(view).lastEvaluatedJavascript
        val result=JSONObject().put("targetSession",target).put("references",JSONArray(references.toString())).put("referenceTarget",targetScript).put("referenceLegacy",legacy).put("textTarget",targetText).put("textLegacy",currentText)
        File(System.getenv("DSH_INCOMING_SCRIPT_REPORT") ?: "build/reports/incoming/main-incoming-scripts.json").apply{parentFile?.mkdirs();writeText(result.toString(2))}
        assertTrue(result.getString("referenceTarget").isNotBlank())
    }
}
