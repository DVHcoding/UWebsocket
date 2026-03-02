import { CLIENT_EVENTS } from "./events.js";
import { RoomManager } from "./room_manager.js";
import { IpLimiter } from "./ip_limiter.js";

// ##########################################################################
// # INIT MANAGERS
// ##########################################################################
const roomManager = new RoomManager();
const ipLimiter = new IpLimiter(30);


// ##########################################################################
// # BUN SERVER
// # - fetch: handle upgrade + limit IP
// # - websocket.message: xử lý event client gửi lên
// # - websocket.close: cleanup khi disconnect
// ##########################################################################
Bun.serve({
    port: 3001,

    fetch(req, server) {
        // ######################################################################
        // # HTTP HANDLER + RATE LIMIT PER IP
        // ######################################################################
        const ip = server.requestIP(req)?.address;
        if (!ip) return new Response("Forbidden", { status: 403 });

        if (!ipLimiter.allow(ip)) {
            return new Response("Too many connections", { status: 429 });
        }

        const cookie = req.headers.get("cookie") || "";

        if (server.upgrade(req, { data: { ip, cookie } })) {
            return;
        }

        return new Response(null, { status: 404 });
    },

    websocket: {
        // ##################################################################
        // # HANDLE INCOMING MESSAGE
        // ##################################################################
        message(ws, raw) {
            try {
                let data;
                try { data = JSON.parse(raw); } catch { return; }

                switch (data.type) {
                    // ##########################################################
                    // # ADD_USER
                    // # - Join room
                    // # - Gửi full user list cho admin
                    // ##########################################################
                    case CLIENT_EVENTS.ADD_USER: {
                        if (!data.roomId || !data.payload) return;
                        roomManager.join(ws, data.roomId, data.payload);
                        roomManager.sendUsersToAdmins(data.roomId);
                        break;
                    }

                    // ##########################################################
                    // # MESSAGE
                    // # - Broadcast message tới toàn bộ room
                    // ##########################################################
                    case CLIENT_EVENTS.MESSAGE: {
                        if (!ws.room) return;

                        const room = roomManager.rooms.get(ws.room);
                        if (!room || !ws.userId) return;

                        const entry = room.users.get(ws.userId);

                        const message = {
                            userId: ws.userId,
                            joinTime: entry?.joinTime ?? null,
                            lastOnline: entry?.lastOnline ?? null
                        };

                        ws.publish(ws.room, JSON.stringify({
                            type: CLIENT_EVENTS.MESSAGE,
                            roomId: ws.room,
                            payload: message
                        }));

                        break;
                    }

                    // ##########################################################
                    // # PREMIUM_ALERT
                    // # - Chỉ xử lý nếu socket đã join room
                    // # - Yêu cầu có targetUserId
                    // # - Gửi alert tới toàn bộ socket của user đó (multi-tab)
                    // # - Không broadcast toàn room
                    // ##########################################################
                    case CLIENT_EVENTS.PREMIUM_ALERT: {
                        if (!ws.room) return;
                        if (!data.payload?.receiverId || !data.payload?.type) return;

                        const { receiverId, type } = data.payload;

                        roomManager.sendPremiumAlert(ws.room, receiverId, {
                            _id: crypto.randomUUID(),
                            receiver: receiverId,
                            type,
                        });

                        break;
                    }


                    // ##########################################################
                    // # REMOVE_USER
                    // # - Leave room
                    // # - Gửi lại full user list cho admin
                    // ##########################################################
                    case CLIENT_EVENTS.REMOVE_USER: {
                        if (!ws.room) return;

                        const roomId = ws.room;
                        roomManager.leave(ws);
                        roomManager.sendUsersToAdmins(roomId);
                        break;
                    }
                }
            } catch (err) {
                console.error("[close] Unhandled error:", err);
            }
        },

        // ##################################################################
        // # CLEANUP WHEN SOCKET CLOSE
        // # - Giảm connection count theo IP
        // # - Remove user khỏi room nếu còn
        // ##################################################################
        close(ws) {
            const ip = ws.data?.ip;
            if (ip) ipLimiter.decrement(ip);

            if (ws.room) {
                const roomId = ws.room;
                roomManager.leave(ws);
                roomManager.sendUsersToAdmins(roomId);
            }

            console.log('Client disconnected')
        }
    }
});

console.log("websocket listening on port 3001");
