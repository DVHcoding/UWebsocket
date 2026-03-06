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
 *   sockets: Set<BunWS>       // tất cả tab/device của user này
 * }
 *
 * interface Room {
 *   users: Map<string, UserEntry>   // key: userId
 * }
 *
 * ws (BunWS) {
 *   rooms: Set<roomId>        // tất cả room socket đang subscribe (thay ws.room cũ)
 *   userId: string
 *   data: { ip, cookie }
 * }
 *
 * Cấu trúc tổng:
 * rooms: Map<roomId, Room>
 *           └── users: Map<userId, UserEntry>
 *                            └── sockets: Set<BunWS>  (multi-tab support)
 *
 * ws.rooms: Set<roomId>       // ngược lại: từ socket biết đang ở room nào
 *
 * Ví dụ:
 * rooms = {
 *   "global":  { users: { "userA": { connections: 2, sockets: {ws1, ws2} } } }
 *   "abc":     { users: { "userA": { connections: 1, sockets: {ws1} },
 *                         "userB": { connections: 1, sockets: {ws3} } } }
 * }
 *
 * ws1.rooms = Set { "global", "abc" }   ← tab 1 của userA
 * ws2.rooms = Set { "global" }          ← tab 2 của userA
 * ws3.rooms = Set { "abc" }             ← tab 1 của userB
 */

export class RoomManager {
    constructor() {
        this.rooms = new Map();
    }

    // ######################################################################
    // # JOIN ROOM
    // ######################################################################
    async join(ws, roomId, userPayload) {
        if (typeof roomId !== "string" || !roomId) return;

        let room = this.rooms.get(roomId);
        if (!room) {
            room = { users: new Map() };
            this.rooms.set(roomId, room);
        }

        const { userId, role } = userPayload;
        if (!userId) return;

        if (!ws.rooms) ws.rooms = new Set();
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
        ws.rooms.add(roomId);
        ws.subscribe(roomId);
    }

    // ######################################################################
    // # LEAVE ROOM
    // ######################################################################
    async leave(ws, roomId) {
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
            const user_status_payload = {
                userId: ws.userId,
                lastOnline: new Date().toISOString()
            }

            await Promise.all([
                this.updateOnlineDuration(ws, ws.userId, onlineDuration),
                this.updateUserStatus(ws, user_status_payload)
            ])

            room.users.delete(ws.userId);
        }

        if (room.users.size === 0) {
            this.rooms.delete(roomId);
        }

        ws.unsubscribe(roomId);
        ws.rooms.delete(roomId);
    }

    // ######################################################################
    // # SOFTLEAVE ROOM
    // ######################################################################
    softLeave(ws, roomId) {
        if (!roomId) return;

        const room = this.rooms.get(roomId);
        if (!room) return;

        const entry = room.users.get(ws.userId);
        if (!entry) return;

        // Xóa socket khỏi room
        entry.sockets.delete(ws);

        // Nếu không còn tab nào trong room → xóa user khỏi room
        if (entry.sockets.size === 0) {
            room.users.delete(ws.userId);
        }

        // Nếu room trống → xóa room
        if (room.users.size === 0) {
            this.rooms.delete(roomId);
        }
    }


    // ######################################################################
    // # SEND SNAPSHOT TO ADMINS
    // ######################################################################
    sendUsersToAdmins() {
        const globalRoom = this.rooms.get("global");
        if (!globalRoom) return;

        const payload = [];
        for (const entry of globalRoom.users.values()) {
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

        for (const entry of globalRoom.users.values()) {
            if (entry.role === "admin") {
                for (const socket of entry.sockets) {
                    socket.send(message);
                }
            }
        }
    }

    // ######################################################################
    // # CHECK USER IN ROOM
    // ######################################################################
    isUserInRoom(roomId, userId) {
        return this.rooms.get(roomId)?.users.has(userId) ?? false;
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

    // ######################################################################
    // # SEND NOTIFICATION ALERT TO SPECIFIC USER
    // ######################################################################
    sendNotificataion(roomId, receiverId, payload) {
        const room = this.rooms.get(roomId);
        if (!room) return;

        const entry = room.users.get(receiverId);
        if (!entry) return;

        const message = JSON.stringify({
            type: CLIENT_EVENTS.NOTIFICATION,
            payload
        });

        for (const socket of entry.sockets) {
            socket.send(message);
        }
    }


    // ######################################################################
    // # SEND TO SPECIFIC USER IN ROOM
    // ######################################################################
    sendToUser(roomId, userId, payload) {
        const room = this.rooms.get(roomId);
        if (!room) return;

        const entry = room.users.get(userId);
        if (!entry) return;

        for (const socket of entry.sockets) {
            socket.send(JSON.stringify(payload));
        }
    }


    async getLastMessage(ws, chatId) {
        try {
            const res = await fetch(`http://127.0.0.1:4000/api/v1/chat/details/${chatId}`, {
                method: "GET",
                headers: {
                    "Content-Type": "application/json",
                    "Cookie": ws.data.cookie || ""
                }
            });
            const data = await res.json();
            return data?.chat?.lastMessage ?? null;
        } catch (err) {
            console.error(err);
            return null;
        }
    }

    async newNotification(ws, data) {
        try {
            await fetch("http://127.0.0.1:4000/api/v1/notification/new", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Cookie": ws.data.cookie || ""
                },
                body: JSON.stringify(data)
            });
        } catch (err) {
            console.error("Lỗi khi fetch:", err);
        }
    }

    // ######################################################################
    // # NEW MESSAGE AND UPDATE DATABASE
    // ######################################################################
    async newMessageForDB(ws, payload) {
        try {
            const { sender, content, chatId, attachments } = payload
            await fetch("http://127.0.0.1:4000/api/v1/message", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Cookie": ws.data.cookie || ""
                },
                body: JSON.stringify({
                    sender,
                    content,
                    attachments,
                    chatId,
                })
            });
        } catch (err) {
            console.error("Lỗi khi fetch:", err);
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
    // # UPDATE LASTONLINE FOR USER
    // ######################################################################
    async updateUserStatus(ws, payload) {
        try {
            const { userId, lastOnline } = payload
            await fetch("http://127.0.0.1:4000/api/v1/userstatus/lastonline", {
                method: "PATCH",
                headers: {
                    "Content-Type": "application/json",
                    "Cookie": ws.data.cookie || ""
                },
                body: JSON.stringify({
                    userId,
                    lastOnline
                })
            });
        } catch (err) {
            console.error("Lỗi khi fetch:", err);
        }
    }

    // ######################################################################
    // # UPDATE CHAT STATUS (MESSAGE SEEN)
    // ######################################################################
    async updateChatMessageStatus(ws, chatId) {
        try {
            await fetch("http://127.0.0.1:4000/api/v1/chat/message/status", {
                method: "PATCH",
                headers: {
                    "Content-Type": "application/json",
                    "Cookie": ws.data.cookie || ""
                },
                body: JSON.stringify({
                    chatId,
                })
            });
        } catch (err) {
            console.error("Lỗi khi fetch:", err);
        }
    }



}
