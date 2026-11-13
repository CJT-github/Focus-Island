package com.focusisland.companion;

import org.junit.Test;
import java.util.Arrays;
import static org.junit.Assert.*;

public class OutboundQueueTest {
    @Test public void waitsForAckBeforeAdvancingAndPreservesMessageOrder() {
        OutboundQueue queue = new OutboundQueue();
        assertTrue(queue.offer(new byte[13])); // two fragments at default MTU
        assertTrue(queue.offer(new byte[]{99}));
        byte[] first = queue.next(23);
        assertNotNull(first);
        assertNull(queue.next(23));
        assertEquals(0, first[4]); assertEquals(2, first[6]);
        assertTrue(queue.acknowledge(true));
        byte[] second = queue.next(517); // current message retains its original fragmentation
        assertEquals(1, second[4]); assertEquals(9, second.length);
        assertTrue(queue.acknowledge(true));
        byte[] third = queue.next(23);
        assertEquals(1, third[2]); assertEquals(99, third[8]);
        assertTrue(queue.acknowledge(true));
        assertNull(queue.next(23));
        assertEquals(0, queue.bytes());
    }

    @Test public void boundsBothBytesAndMessageCountWithoutDiscardingInflightData() {
        OutboundQueue queue = new OutboundQueue();
        for (int i = 0; i < 8; i++) assertTrue(queue.offer(new byte[8192]));
        assertFalse(queue.offer(new byte[]{1}));
        assertEquals(65536, queue.bytes());
        queue.clear();
        for (int i = 0; i < 32; i++) assertTrue(queue.offer(new byte[]{1}));
        assertFalse(queue.offer(new byte[]{2}));
        assertEquals(32, queue.size());
    }

    @Test public void failureAndDisconnectPurgeAllPendingPayloads() {
        OutboundQueue queue = new OutboundQueue();
        queue.offer(new byte[]{1}); queue.offer(new byte[]{2});
        queue.next(23);
        assertFalse(queue.acknowledge(false));
        assertEquals(0, queue.size()); assertEquals(0, queue.bytes()); assertNull(queue.next(23));
        queue.offer(new byte[100]); queue.next(23);
        queue.clear();
        assertFalse(queue.acknowledge(true));
        assertNull(queue.next(23));
        queue.offer(new byte[]{3});
        assertEquals(3, queue.next(23)[8]);
    }

    @Test public void copiesCallerBuffersAndFrames() {
        OutboundQueue queue = new OutboundQueue();
        byte[] payload = {12};
        queue.offer(payload);
        Arrays.fill(payload, (byte) 5);
        byte[] frame = queue.next(23);
        assertEquals(12, frame[8]);
        Arrays.fill(frame, (byte) 0);
        assertTrue(queue.acknowledge(true));
        assertEquals(0, queue.size());
    }
}
