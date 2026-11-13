package com.focusisland.companion;

import org.junit.Test;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import static org.junit.Assert.*;

public class ProtocolTest {
    private static int u16(byte[] value, int offset) { return (value[offset] & 255) | (value[offset + 1] & 255) << 8; }
    private static byte[] reassemble(List<byte[]> frames, int mtu, int messageId) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (int i = 0; i < frames.size(); i++) {
            byte[] frame = frames.get(i);
            assertEquals(1, frame[0]); assertEquals(0, frame[1]);
            assertEquals(messageId, u16(frame, 2)); assertEquals(i, u16(frame, 4));
            assertEquals(frames.size(), u16(frame, 6));
            assertTrue(frame.length <= Math.min(mtu - 3, 512));
            out.write(frame, 8, frame.length - 8);
        }
        return out.toByteArray();
    }

    @Test public void defaultMtuReassemblesMultibytePayload() {
        byte[] payload = Protocol.posted("a", "微信", "com.example.chat", "通知 😀", "中文跨越分片边界".repeat(40), 1234, false);
        assertArrayEquals(payload, reassemble(Protocol.fragment(payload, 23, 0x1234), 23, 0x1234));
    }

    @Test public void exactMaximumBytesAndLargestMtu() {
        byte[] payload = new byte[8192];
        for (int i = 0; i < payload.length; i++) payload[i] = (byte) i;
        List<byte[]> frames = Protocol.fragment(payload, 517, 65535);
        assertEquals(17, frames.size());
        assertArrayEquals(payload, reassemble(frames, 517, 65535));
    }

    @Test public void invalidSizesAreRejected() {
        for (int size : new int[]{0, 8193}) {
            try { Protocol.fragment(new byte[size], 23, 0); fail(); }
            catch (IllegalArgumentException expected) {}
        }
        for (int mtu : new int[]{22, 518}) {
            try { Protocol.fragment(new byte[]{1}, mtu, 0); fail(); }
            catch (IllegalArgumentException expected) {}
        }
        try { Protocol.json("汉".repeat(2731)); fail(); }
        catch (IllegalArgumentException expected) {}
    }

    @Test public void clippingPreservesUnicodeAndRemovesControlCharacters() {
        assertEquals("😀😀", Protocol.clip("😀😀Z", 2));
        assertEquals("a\uFFFDb\uFFFD", Protocol.clip("a\uD800b\uDC00", 10));
        assertEquals("abc\n\t", Protocol.clip("a\u0000b\u202ec\n\t", 20));
    }

    @Test public void nameOnlyDoesNotSerializeContent() {
        String payload = new String(Protocol.posted("x", "Chat", "com.example.chat", "private-title",
                "private-body", 42, true), StandardCharsets.UTF_8);
        assertFalse(payload.contains("private-"));
        assertTrue(payload.contains("\"title\":\"\",\"body\":\"\""));
        assertTrue(payload.startsWith("{\"version\":1,\"type\":\"posted\""));
        assertTrue(payload.contains("\"time\":42"));
    }

    @Test public void wireExamplesAndJsonEscaping() {
        assertEquals("{\"version\":1,\"type\":\"status\",\"notificationAccess\":true,\"name\":\"Phone\"}",
                new String(Protocol.status(true, "Phone"), StandardCharsets.UTF_8));
        assertEquals("{\"version\":1,\"type\":\"removed\",\"id\":\"abc\"}",
                new String(Protocol.removed("abc"), StandardCharsets.UTF_8));
        assertEquals("\"a\\\"b\\\\c\\n\\t\"", Protocol.quote("a\"b\\c\n\t"));
        assertTrue(new String(Protocol.posted("x", "App", "pkg", "", "", -1, false),
                StandardCharsets.UTF_8).endsWith("\"time\":0}"));
    }

    @Test public void stableHashDoesNotTruncateLongKeysOrLeakThem() {
        String key = "sensitive-key".repeat(100);
        assertEquals(64, Protocol.id(key).length());
        assertTrue(Protocol.id(key).matches("[a-f0-9]{64}"));
        assertEquals(Protocol.id(key), Protocol.id(key));
        assertNotEquals(Protocol.id(key + "a"), Protocol.id(key + "b"));
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
                Protocol.id("abc"));
    }

    @Test public void worstCaseEscapingStillFitsProtocolBound() {
        byte[] payload = Protocol.posted("x".repeat(64), "😀".repeat(128),
                "😀".repeat(255), "\"".repeat(1000), "\\".repeat(1000), Long.MAX_VALUE, false);
        assertTrue(payload.length <= 8192);
        String json = new String(payload, StandardCharsets.UTF_8);
        assertTrue(json.contains("\"title\":" + Protocol.quote("\"".repeat(160))));
        assertTrue(json.contains("\"body\":" + Protocol.quote("\\".repeat(500))));
    }
}
