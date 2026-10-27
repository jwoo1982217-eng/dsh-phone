package com.dshphone.startup;

import android.graphics.Bitmap;
import android.media.MediaMetadataRetriever;
import java.io.File;
import java.io.IOException;

/** Validate actual local video metadata and decode one bounded preview frame before activation. */
final class AndroidVideoProbe implements StartupVideoStore.Probe {
    @Override public StartupVideoStore.Media inspect(File file) throws IOException {
        MediaMetadataRetriever retriever = new MediaMetadataRetriever(); Bitmap preview = null;
        try {
            retriever.setDataSource(file.getAbsolutePath());
            boolean hasVideo = "yes".equalsIgnoreCase(retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_HAS_VIDEO));
            long duration = number(retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION));
            int width = dimension(retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH));
            int height = dimension(retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT));
            String mime = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_MIMETYPE);
            String error = StartupPolicy.mediaRejection(hasVideo, duration, width, height, mime);
            if (error != null) throw new IOException(error);
            preview = retriever.getScaledFrameAtTime(0, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, 320, 320);
            if (preview == null) throw new IOException("decode-failed");
            return new StartupVideoStore.Media(true, duration, width, height, mime);
        } catch (RuntimeException e) { throw new IOException("decode-failed", e); }
        finally {
            if (preview != null) preview.recycle();
            try { retriever.release(); } catch (Exception ignored) { }
        }
    }
    private static long number(String value) { try { return Long.parseLong(value); } catch (NumberFormatException e) { return -1; } }
    private static int dimension(String value) { long result = number(value); return result > 0 && result <= Integer.MAX_VALUE ? (int) result : -1; }
}
