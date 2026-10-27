package com.dshphone.startup;

import static org.junit.Assert.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Before;
import org.junit.After;
import org.junit.Test;

public class StartupVideoStoreTest {
    private Path root;
    private StartupVideoStore store;
    private final StartupVideoStore.Probe valid = file -> new StartupVideoStore.Media(true, 1200, 320, 180, "video/mp4");
    @Before public void setup() throws Exception { root = Files.createTempDirectory("startup-store-"); store = new StartupVideoStore(root.toFile(), valid); }
    @After public void cleanup() throws Exception { try (java.util.stream.Stream<Path> all = Files.walk(root)) { all.sorted(java.util.Comparator.reverseOrder()).forEach(p -> p.toFile().delete()); } }
    @Test public void absentByDefaultAndAtomicallyReplacesOnlyAfterValidation() throws Exception {
        assertNull(store.current());
        StartupVideoStore.Info first = save("one.mp4", "video-one"); assertEquals("one.mp4", store.current().name);
        StartupVideoStore.Info second = save("假期 两.mp4", "video-two"); assertEquals("假期 两.mp4", store.current().name);
        assertFalse(first.file.exists()); assertTrue(second.file.exists()); assertEquals(1200, second.media.duration);
        assertEquals("video-two", new String(Files.readAllBytes(second.file.toPath()), StandardCharsets.UTF_8)); assertEquals(0, pendingCount());
    }
    @Test public void failedDecoderEmptyAndTruncatedSourcesKeepPreviousVideo() throws Exception {
        StartupVideoStore.Info previous = save("old.mp4", "old-video");
        reject(() -> new StartupVideoStore(root.toFile(), f -> { throw new IOException("bad codec"); })
                .importVideo("bad.mp4", "video/mp4", -1, source("unplayable"), new StartupVideoStore.Cancel()));
        reject(() -> store.importVideo("empty.mp4", "video/mp4", -1, source(""), new StartupVideoStore.Cancel()));
        reject(() -> store.importVideo("short.mp4", "video/mp4", 200, source("short"), new StartupVideoStore.Cancel()));
        assertEquals(previous.file, store.current().file); assertEquals("old-video", new String(Files.readAllBytes(previous.file.toPath()), StandardCharsets.UTF_8)); assertEquals(0, pendingCount());
    }
    @Test public void actualSizeLimitIsEnforcedForUnknownAndLyingProviders() throws Exception {
        StartupVideoStore.Info previous = save("old.mp4", "old-video"); AtomicInteger opens = new AtomicInteger();
        reject(() -> store.importVideo("too-large.mp4", "video/mp4", StartupPolicy.MAX_BYTES+1,
                () -> { opens.incrementAndGet(); return new ByteArrayInputStream(new byte[0]); }, new StartupVideoStore.Cancel()));
        assertEquals(0, opens.get());
        reject(() -> store.importVideo("large.mp4", "video/mp4", -1, () -> new InputStream() {
            long remaining = StartupPolicy.MAX_BYTES + 1;
            public int read() { if (remaining-- > 0) return 0; return -1; }
            public int read(byte[] b,int o,int l) { if (remaining <= 0) return -1; int n=(int)Math.min(l,remaining); java.util.Arrays.fill(b,o,o+n,(byte)0);remaining-=n;return n; }
        }, new StartupVideoStore.Cancel()));
        assertEquals(previous.file, store.current().file); assertEquals(0, pendingCount());
    }
    @Test public void cancellationBeforeOpenAndDuringCopyKeepsPreviousAndRemovesStaging() throws Exception {
        StartupVideoStore.Info previous = save("old.mp4", "old-video");
        StartupVideoStore.Cancel before = new StartupVideoStore.Cancel(); before.cancel();
        reject(() -> store.importVideo("new.mp4","video/mp4",-1,()->{ fail("must not open");return null;},before));
        StartupVideoStore.Cancel during = new StartupVideoStore.Cancel();
        reject(() -> store.importVideo("new.mp4","video/mp4",-1,()->new ByteArrayInputStream(new byte[20]) {
            @Override public synchronized int read(byte[] b,int o,int n) { int result=super.read(b,o,n);during.cancel();return result; }
        },during));
        assertEquals(previous.file,store.current().file);assertEquals(0,pendingCount());
    }
    @Test public void failedAtomicPointerSwapDoesNotDestroyPreviousVideo() throws Exception {
        StartupVideoStore.Info previous = save("old.mp4", "old-video");
        StartupVideoStore failed = new StartupVideoStore(root.toFile(), valid, (from,to)-> {
            if (to.getName().equals("current.properties")) throw new IOException("injected atomic metadata failure");
            Files.move(from.toPath(),to.toPath(),StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);
        });
        reject(() -> failed.importVideo("new.mp4","video/mp4",-1,source("new-video"),new StartupVideoStore.Cancel()));
        assertEquals(previous.file,store.current().file); assertTrue(previous.file.exists()); assertEquals(0,pendingCount());
        assertEquals(1, videoCount());
    }
    @Test public void clearCancelsLateCommitEvenWhenNoVideoWasConfigured() throws Exception {
        CountDownLatch entered = new CountDownLatch(1), proceed = new CountDownLatch(1);
        ExecutorService executor = Executors.newSingleThreadExecutor();
        try {
            Future<?> pending = executor.submit(() -> { try {
                store.importVideo("new.mp4","video/mp4",-1,()->new ByteArrayInputStream("new-video".getBytes(StandardCharsets.UTF_8)) {
                    @Override public synchronized int read(byte[] b,int o,int n) {
                        entered.countDown(); try { if (!proceed.await(5,TimeUnit.SECONDS)) throw new IllegalStateException("test timeout"); }
                        catch(InterruptedException e){Thread.currentThread().interrupt();throw new IllegalStateException(e);} return super.read(b,o,n);
                    }
                },new StartupVideoStore.Cancel()); fail("Late import must not resurrect removed configuration");
            } catch(IOException expected) { } });
            assertTrue(entered.await(5,TimeUnit.SECONDS)); store.clear(); proceed.countDown(); pending.get(5,TimeUnit.SECONDS);
            assertNull(store.current()); assertEquals(0,pendingCount()); assertEquals(0,videoCount());
        } finally { proceed.countDown(); executor.shutdownNow(); }
    }
    @Test public void sourceFailureAndCancellationDuringProbeAreRecoverable() throws Exception {
        StartupVideoStore.Info previous = save("old.mp4", "old-video");
        reject(() -> store.importVideo("new.mp4","video/mp4",-1,()->{throw new IOException("provider lost grant");},new StartupVideoStore.Cancel()));
        StartupVideoStore.Cancel cancel = new StartupVideoStore.Cancel();
        reject(() -> new StartupVideoStore(root.toFile(), f->{cancel.cancel();return valid.inspect(f);})
                .importVideo("new.mp4","video/mp4",-1,source("new-video"),cancel));
        assertEquals(previous.file,store.current().file);save("recovered.mp4","recovered");assertEquals("recovered.mp4",store.current().name);
    }
    @Test public void displayNameNeverSelectsADestinationAndClearTouchesOnlyOwnedFiles() throws Exception {
        StartupVideoStore.Info info = save("../../outside.mp4","video"); assertEquals(root.toFile().getCanonicalFile(),info.file.getParentFile().getCanonicalFile());
        File unrelated = root.resolve("user-notes.txt").toFile();Files.write(unrelated.toPath(), "keep".getBytes(StandardCharsets.UTF_8));store.clear();
        assertNull(store.current());assertTrue(unrelated.exists());assertEquals(0,videoCount());
    }
    private StartupVideoStore.Info save(String name,String bytes) throws Exception {
        return store.importVideo(name,"video/mp4",-1,source(bytes),new StartupVideoStore.Cancel());
    }
    private StartupVideoStore.Source source(String text){return ()->new ByteArrayInputStream(text.getBytes(StandardCharsets.UTF_8));}
    private long pendingCount() throws IOException {try(java.util.stream.Stream<Path> all=Files.list(root)){return all.filter(x->x.getFileName().toString().startsWith("pending-")||x.getFileName().toString().startsWith("pointer-")).count();}}
    private long videoCount() throws IOException {try(java.util.stream.Stream<Path> all=Files.list(root)){return all.filter(x->x.getFileName().toString().startsWith("video-")).count();}}
    private interface Checked {void run() throws Exception;}
    private static void reject(Checked action)throws Exception{try{action.run();fail("Expected rejection");}catch(IOException expected){}}
}
