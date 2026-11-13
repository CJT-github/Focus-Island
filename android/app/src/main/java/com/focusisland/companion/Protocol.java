package com.focusisland.companion;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.List;

/** Pure wire codec: no notification payload is written to disk or logs. */
final class Protocol {
    static final int MAX_MESSAGE_BYTES = 8192;
    static final String SERVICE_UUID = "7b5e0001-6b7d-4a8f-9c10-6a2d3f4b5c60";
    static final String NOTIFY_UUID = "7b5e0002-6b7d-4a8f-9c10-6a2d3f4b5c60";
    static final String CCCD_UUID = "00002902-0000-1000-8000-00805f9b34fb";

    private Protocol() {}

    static String clip(CharSequence input, int codePoints) {
        if (input == null || codePoints <= 0) return "";
        StringBuilder out = new StringBuilder();
        for (int offset = 0, count = 0; offset < input.length() && count < codePoints; count++) {
            char ch = input.charAt(offset++);
            int cp = ch;
            if (Character.isHighSurrogate(ch)) {
                if (offset < input.length() && Character.isLowSurrogate(input.charAt(offset))) {
                    cp = Character.toCodePoint(ch, input.charAt(offset++));
                } else cp = 0xfffd;
            } else if (Character.isLowSurrogate(ch)) cp = 0xfffd;
            // Keep readable whitespace, remove control and bidi override characters.
            if ((cp < 32 && cp != '\n' && cp != '\t') || cp == 127
                    || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) continue;
            out.appendCodePoint(cp);
        }
        return out.toString();
    }

    static String quote(String input) {
        StringBuilder out = new StringBuilder("\"");
        for (int i = 0; i < input.length(); i++) {
            char ch = input.charAt(i);
            switch (ch) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                default:
                    if (ch < 32) out.append(String.format(java.util.Locale.ROOT, "\\u%04x", (int) ch));
                    else out.append(ch);
            }
        }
        return out.append('"').toString();
    }

    static String id(String notificationKey) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(notificationKey.getBytes(StandardCharsets.UTF_8));
            StringBuilder out = new StringBuilder(64);
            for (byte value : digest) out.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
            return out.toString();
        } catch (NoSuchAlgorithmException impossible) {
            throw new AssertionError(impossible);
        }
    }

    static byte[] posted(String id, String app, String pkg, CharSequence title,
                         CharSequence body, long time, boolean nameOnly) {
        return json("{\"version\":1,\"type\":\"posted\",\"id\":" + quote(clip(id, 64))
                + ",\"app\":" + quote(clip(app, 128)) + ",\"package\":" + quote(clip(pkg, 255))
                + ",\"title\":" + quote(nameOnly ? "" : clip(title, 160))
                + ",\"body\":" + quote(nameOnly ? "" : clip(body, 500))
                + ",\"time\":" + Math.max(0L, time) + "}");
    }

    static byte[] removed(String id) {
        return json("{\"version\":1,\"type\":\"removed\",\"id\":" + quote(clip(id, 64)) + "}");
    }

    static byte[] status(boolean access, String name) {
        return json("{\"version\":1,\"type\":\"status\",\"notificationAccess\":" + access
                + ",\"name\":" + quote(clip(name, 128)) + "}");
    }

    static byte[] json(String value) {
        byte[] payload = value.getBytes(StandardCharsets.UTF_8);
        if (payload.length == 0 || payload.length > MAX_MESSAGE_BYTES)
            throw new IllegalArgumentException("Message exceeds protocol bounds");
        return payload;
    }

    static List<byte[]> fragment(byte[] payload, int mtu, int messageId) {
        if (payload.length == 0 || payload.length > MAX_MESSAGE_BYTES || mtu < 23 || mtu > 517)
            throw new IllegalArgumentException("Invalid frame size");
        // ATT values are at most 512 bytes even when MTU is 517.
        int capacity = Math.min(mtu - 3, 512) - 8;
        int count = (payload.length + capacity - 1) / capacity;
        List<byte[]> frames = new ArrayList<>(count);
        for (int index = 0, offset = 0; index < count; index++) {
            int length = Math.min(capacity, payload.length - offset);
            byte[] frame = new byte[length + 8];
            frame[0] = 1;
            put16(frame, 2, messageId);
            put16(frame, 4, index);
            put16(frame, 6, count);
            System.arraycopy(payload, offset, frame, 8, length);
            offset += length;
            frames.add(frame);
        }
        return frames;
    }

    private static void put16(byte[] frame, int index, int value) {
        frame[index] = (byte) value;
        frame[index + 1] = (byte) (value >>> 8);
    }
}
