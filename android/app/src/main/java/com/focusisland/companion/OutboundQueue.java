package com.focusisland.companion;

import java.util.ArrayDeque;
import java.util.List;

/** One outstanding ATT notification; callers disconnect on rejection or failed ACK. */
final class OutboundQueue {
    static final int MAX_MESSAGES = 32;
    static final int MAX_BYTES = 64 * 1024;
    private final ArrayDeque<byte[]> messages = new ArrayDeque<>();
    private List<byte[]> frames;
    private int frameIndex, messageId, bytes;
    private boolean waiting;

    boolean offer(byte[] message) {
        if (message.length == 0 || message.length > Protocol.MAX_MESSAGE_BYTES
                || messages.size() >= MAX_MESSAGES || bytes + message.length > MAX_BYTES) return false;
        messages.add(message.clone());
        bytes += message.length;
        return true;
    }

    byte[] next(int mtu) {
        if (waiting || messages.isEmpty()) return null;
        if (frames == null) {
            frames = Protocol.fragment(messages.peek(), mtu, messageId++ & 0xffff);
            frameIndex = 0;
        }
        waiting = true;
        return frames.get(frameIndex).clone();
    }

    boolean acknowledge(boolean success) {
        if (!waiting) return false;
        waiting = false;
        if (!success) { clear(); return false; }
        if (++frameIndex == frames.size()) {
            bytes -= messages.remove().length;
            frames = null;
        }
        return true;
    }

    void clear() {
        messages.clear();
        frames = null;
        frameIndex = 0;
        bytes = 0;
        waiting = false;
        // Keep messageId monotonic between sessions to make stale fragments easier to reject.
    }

    int size() { return messages.size(); }
    int bytes() { return bytes; }
    boolean waiting() { return waiting; }
}
