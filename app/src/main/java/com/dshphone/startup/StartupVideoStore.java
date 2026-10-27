package com.dshphone.startup;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.HashMap;
import java.util.Map;
import java.util.Properties;
import java.util.UUID;

/** Bounded private file transaction; invalid/cancelled imports never overwrite the previous video. */
public final class StartupVideoStore {
    public interface Source { InputStream open() throws IOException; }
    public interface Probe { Media inspect(File file) throws IOException; }
    public interface Mover { void move(File from, File to) throws IOException; }
    private static final Object LOCK = new Object();
    private static final Map<String, Long> revisions = new HashMap<>();
    private final File directory;
    private final Probe probe;
    private final Mover mover;

    public static final class Media {
        public final boolean hasVideo;
        public final long duration;
        public final int width, height;
        public final String mime;
        public Media(boolean video, long duration, int width, int height, String mime) {
            hasVideo = video; this.duration = duration; this.width = width; this.height = height; this.mime = mime;
        }
    }
    public static final class Info {
        public final File file;
        public final String name;
        public final long bytes;
        public final Media media;
        Info(File file, String name, long bytes, Media media) { this.file = file; this.name = name; this.bytes = bytes; this.media = media; }
    }
    public static final class Cancel {
        private volatile boolean cancelled;
        private volatile InputStream active;
        private volatile Runnable hook;
        public void cancel() {
            cancelled = true; Runnable action = hook; if (action != null) action.run();
            InputStream stream = active; if (stream != null) try { stream.close(); } catch (IOException ignored) { }
        }
        public boolean isCancelled() { return cancelled; }
        public void setHook(Runnable action) { hook = action; if (cancelled && action != null) action.run(); }
        public void check() throws IOException { if (cancelled || Thread.currentThread().isInterrupted()) throw new IOException("cancelled"); }
        private void use(InputStream stream) throws IOException { active = stream; if (cancelled) { stream.close(); check(); } }
        private void clearStream() { active = null; }
    }

    public StartupVideoStore(File directory, Probe probe) {
        this(directory, probe, (from, to) -> Files.move(from.toPath(), to.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING));
    }
    public StartupVideoStore(File directory, Probe probe, Mover mover) {
        try { this.directory = directory.getCanonicalFile(); }
        catch (IOException e) { throw new IllegalArgumentException("Invalid private startup directory", e); }
        this.probe = probe; this.mover = mover;
    }
    public Info current() throws IOException { synchronized (LOCK) { return currentLocked(); } }

    public Info importVideo(String displayName, String mime, long declaredBytes, Source source, Cancel cancel) throws IOException {
        String rejection = StartupPolicy.rejection(displayName, mime, declaredBytes);
        if (rejection != null) throw new IOException(rejection);
        cancel.check();
        final long revision;
        synchronized (LOCK) { revision = revision(); }
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("io-failed");
        File staged = File.createTempFile("pending-", ".part", directory);
        File finalVideo = new File(directory, "video-" + UUID.randomUUID() + ".media");
        File pointer = null; boolean committed = false;
        long deadline = System.nanoTime() + StartupPolicy.COPY_TIMEOUT_MILLIS * 1000000;
        try {
            long written = 0;
            InputStream stream = source.open(); if (stream == null) throw new IOException("unreadable");
            cancel.use(stream);
            try (InputStream input = stream; FileOutputStream output = new FileOutputStream(staged)) {
                byte[] buffer = new byte[64 * 1024];
                while (true) {
                    check(cancel, deadline); int read = input.read(buffer); if (read == -1) break;
                    written += read; if (written > StartupPolicy.MAX_BYTES) throw new IOException("too-large");
                    output.write(buffer, 0, read);
                }
                output.getFD().sync();
            } finally { cancel.clearStream(); }
            if (!StartupPolicy.validSize(written)) throw new IOException("empty");
            if (declaredBytes > 0 && declaredBytes != written) throw new IOException("size-changed");
            check(cancel, deadline);
            Media media = probe.inspect(staged);
            rejection = media == null ? "decode-failed" : StartupPolicy.mediaRejection(media.hasVideo, media.duration, media.width, media.height, media.mime);
            if (rejection != null) throw new IOException(rejection);
            check(cancel, deadline);
            synchronized (LOCK) {
                cancel.check(); if (revision != revision()) throw new IOException("superseded");
                Info previous = currentLocked();
                mover.move(staged, finalVideo);
                if (!finalVideo.setReadOnly()) throw new IOException("io-failed");
                Properties record = new Properties();
                record.setProperty("file", finalVideo.getName()); record.setProperty("name", StartupPolicy.displayName(displayName));
                record.setProperty("bytes", Long.toString(written)); record.setProperty("duration", Long.toString(media.duration));
                record.setProperty("width", Integer.toString(media.width)); record.setProperty("height", Integer.toString(media.height));
                record.setProperty("mime", media.mime == null ? "" : media.mime);
                pointer = File.createTempFile("pointer-", ".part", directory);
                try (FileOutputStream output = new FileOutputStream(pointer)) { record.store(output, "DSH local startup video"); output.getFD().sync(); }
                cancel.check();
                mover.move(pointer, new File(directory, "current.properties"));
                committed = true; bumpRevision();
                // The active pointer is already durable. A failed old-file deletion cannot undo it.
                if (previous != null && !previous.file.equals(finalVideo)) previous.file.delete();
                return new Info(finalVideo, StartupPolicy.displayName(displayName), written, media);
            }
        } finally {
            staged.delete(); if (pointer != null) pointer.delete(); if (!committed) finalVideo.delete();
        }
    }

    public void clear() throws IOException {
        synchronized (LOCK) {
            bumpRevision();
            File pointer = new File(directory, "current.properties");
            if (pointer.exists() && !pointer.delete()) throw new IOException("io-failed");
            File[] files = directory.listFiles(); if (files == null) return;
            boolean failed = false;
            for (File file : files) if (file.isFile() && file.getName().matches("video-[a-f0-9-]{36}\\.media"))
                failed |= !file.delete();
            if (failed) throw new IOException("cleanup-incomplete");
        }
    }

    private Info currentLocked() throws IOException {
        File pointer = new File(directory, "current.properties");
        if (!pointer.isFile()) return null;
        if (pointer.length() > 16384) throw new IOException("invalid-record");
        Properties record = new Properties();
        try (InputStream input = new FileInputStream(pointer)) { record.load(input); }
        try {
            String filename = record.getProperty("file", "");
            if (!filename.matches("video-[a-f0-9-]{36}\\.media")) throw new IOException("invalid-record");
            File file = new File(directory, filename).getCanonicalFile();
            if (!directory.getCanonicalFile().equals(file.getParentFile())) throw new IOException("invalid-record");
            long size = Long.parseLong(record.getProperty("bytes"));
            if (!file.isFile() || !StartupPolicy.validSize(size) || size != file.length()) return null;
            Media media = new Media(true, Long.parseLong(record.getProperty("duration")), Integer.parseInt(record.getProperty("width")),
                    Integer.parseInt(record.getProperty("height")), record.getProperty("mime"));
            if (StartupPolicy.mediaRejection(media.hasVideo, media.duration, media.width, media.height, media.mime) != null) return null;
            return new Info(file, StartupPolicy.displayName(record.getProperty("name")), size, media);
        } catch (NumberFormatException e) { throw new IOException("invalid-record", e); }
    }
    private long revision() { Long value = revisions.get(directory.getAbsolutePath()); return value == null ? 0 : value; }
    private void bumpRevision() { revisions.put(directory.getAbsolutePath(), revision() + 1); }
    private static void check(Cancel cancel, long deadline) throws IOException {
        cancel.check(); if (System.nanoTime() > deadline) throw new IOException("timeout");
    }
}
