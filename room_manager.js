

import { CLIENT_EVENTS } from "./events.js";

// ##########################################################################
// # ROOM MANAGER
// # - Quản lý toàn bộ room state trong memory
// ##########################################################################

/**
 * @typedef {import("bun").ServerWebSocket<{ ip: string, cookie: string }>} BunWS
 *
 * type UserEntry = {
 *   userId: string
 *   role: string
 *   joinTime: number
 *   lastOnline: number | null
 *   connections: number
 *   sockets: Set<BunWS>  // tất cả tab/device của user này
 * }
 *
 * interface Room {
 *   users: Map<string, UserEntry>   // key: userId
 * }
 *
 * Cấu trúc tổng:
 * rooms: Map<roomId, Room>
 *           └── users: Map<userId, UserEntry>
 *                            └── sockets: Set<BunWS>  (multi-tab support)
 */

export class RoomManager {
    constructor() {
        this.rooms = new Map();
    }

    // ######################################################################
    // # JOIN ROOM
    // ######################################################################
    join(ws, roomId, userPayload) {
        if (typeof roomId !== "string" || !roomId) return;
        if (ws.room) this.leave(ws);

        let room = this.rooms.get(roomId);
        if (!room) {
            room = { users: new Map() };
            this.rooms.set(roomId, room);
        }

        const { userId, role } = userPayload;
        if (!userId) return;

        ws.room = roomId;
        ws.userId = userId;

        let entry = room.users.get(userId);

        if (!entry) {
            entry = {
                userId,
                role,
                joinTime: Date.now(),
                lastOnline: null,
                connections: 0,
                sockets: new Set()
            };
            room.users.set(userId, entry);
        }

        entry.connections++;
        entry.sockets.add(ws);

        ws.subscribe(roomId);
    }

    // ######################################################################
    // # LEAVE ROOM
    // ######################################################################
    async leave(ws) {
        const roomId = ws.room;
        if (!roomId) return;

        const room = this.rooms.get(roomId);
        if (!room) return;

        const entry = room.users.get(ws.userId);
        if (!entry) return;

        entry.connections--;
        entry.sockets.delete(ws);

        if (entry.connections === 0) {
            entry.lastOnline = Date.now();

            const onlineDuration = entry.lastOnline - entry.joinTime;

            await this.updateOnlineDuration(ws, ws.userId, onlineDuration);

            room.users.delete(ws.userId);
        }

        if (room.users.size === 0) {
            this.rooms.delete(roomId);
        }

        ws.unsubscribe(roomId);
        ws.room = null;
    }

    // ######################################################################
    // # SEND SNAPSHOT TO ADMINS
    // ######################################################################
    sendUsersToAdmins(roomId) {
        const room = this.rooms.get(roomId);
        if (!room) return;

        const payload = [];

        for (const entry of room.users.values()) {
            payload.push({
                userId: entry.userId,
                role: entry.role,
                joinTime: entry.joinTime,
                lastOnline: entry.lastOnline
            });
        }

        const message = JSON.stringify({
            type: CLIENT_EVENTS.ADD_USER,
            payload
        });

        for (const entry of room.users.values()) {
            if (entry.role === "admin") {
                for (const socket of entry.sockets) {
                    socket.send(message);
                }
            }
        }
    }

    // ######################################################################
    // # UPDATE DURATION FOR STUDYTIME
    // ######################################################################
    async updateOnlineDuration(ws, userId, timestamp) {
        try {
            await fetch("http://127.0.0.1:4000/api/v1/studytime", {
                method: "PATCH",
                headers: {
                    "Content-Type": "application/json",
                    "Cookie": ws.data.cookie || ""
                },
                body: JSON.stringify({
                    userId,
                    duration: timestamp
                })
            });
        } catch (err) {
            console.error("Lỗi khi fetch:", err);
        }
    }

    // ######################################################################
    // # SEND PREMIUM ALERT TO SPECIFIC USER
    // ######################################################################
    sendPremiumAlert(roomId, receiverId, payload) {
        const room = this.rooms.get(roomId);
        if (!room) return;

        const entry = room.users.get(receiverId);
        if (!entry) return;

        const message = JSON.stringify({
            type: CLIENT_EVENTS.PREMIUM_ALERT,
            payload  // { _id, receiver, type }
        });

        for (const socket of entry.sockets) {
            socket.send(message);
        }
    }
}
