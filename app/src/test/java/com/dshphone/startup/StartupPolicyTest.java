package com.dshphone.startup;
import static org.junit.Assert.*;
import org.junit.Test;
public class StartupPolicyTest {
 @Test public void preservesExistingAutomaticStartAsDefault() {
  assertTrue(StartupPolicy.autoStart(null)); assertTrue(StartupPolicy.autoStart(true)); assertFalse(StartupPolicy.autoStart(false));
 }
 @Test public void refusesTsByNameOrMimeAndBoundsEveryActualByte() {
  assertEquals("forbidden-ts", StartupPolicy.rejection("VIDEO.TS", "video/mp4", 12));
  assertEquals("forbidden-ts", StartupPolicy.rejection("renamed.mp4", " Video/MP2T ;codecs=x", -1));
  assertEquals("too-large", StartupPolicy.rejection("normal.mp4", "video/mp4", StartupPolicy.MAX_BYTES + 1));
  assertNull(StartupPolicy.rejection("正常 视频.mp4", "video/mp4", -1));
  assertFalse(StartupPolicy.validSize(0)); assertTrue(StartupPolicy.validSize(StartupPolicy.MAX_BYTES));
  assertFalse(StartupPolicy.validSize(StartupPolicy.MAX_BYTES + 1));
 }
 @Test public void requiresRealVideoDimensionsAndPositiveDuration() {
  assertNull(StartupPolicy.mediaRejection(true, 1000, 1920, 1080, "video/mp4"));
  assertEquals("decode-failed", StartupPolicy.mediaRejection(false, 1000, 1920, 1080, "audio/mp4"));
  assertEquals("decode-failed", StartupPolicy.mediaRejection(true, 0, 1920, 1080, "video/mp4"));
  assertEquals("decode-failed", StartupPolicy.mediaRejection(true, 1000, 0, 1080, "video/mp4"));
  assertEquals("forbidden-ts", StartupPolicy.mediaRejection(true, 1000, 1920, 1080, "video/mp2t"));
 }
 @Test public void namesAreDisplayOnlyAndCannotBecomePaths() {
  assertEquals("假期 视频.mp4", StartupPolicy.displayName("/private/folder/假期 视频.mp4"));
  assertEquals("video", StartupPolicy.displayName(""));
  assertTrue(StartupPolicy.displayName("x".repeat(400)).length() <= 160);
 }
}
