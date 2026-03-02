import { CLIENT_EVENTS } from "./events.js";

// ##########################################################################
// # GLOBAL STATE
// # - ipConnections: giới hạn số connection theo IP
// # - rooms: lưu toàn bộ room đang tồn tại trong memory
// ##########################################################################
const ipConnections = new Map();
const MAX_PER_IP = 10;

const rooms = new Map();
// roomId -> {
//   users: Map<userId, {
//       userId,
//       role,
//       joinTime,
//       lastOnline,
//       connections,
//       sockets: Set<WebSocket>
//   }>
// }


// ##########################################################################
// # JOIN ROOM
// # - Nếu ws đã thuộc room khác → rời room cũ
// # - Tạo room nếu chưa tồn tại
// # - Admin lưu trong Set
// # - User lưu theo userId + đếm số connection
// ##########################################################################
function join(ws, roomId, userPayload) {
    if (typeof roomId !== "string" || !roomId) return;
    if (ws.room) leave(ws);

    let room = rooms.get(roomId);
    if (!room) {
        room = { users: new Map() };
        rooms.set(roomId, room);
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

// ##########################################################################
// # LEAVE ROOM
// # - Xóa admin khỏi Set
// # - Giảm connections của user
// # - Nếu connections = 0 → xóa user khỏi room
// # - Nếu room rỗng hoàn toàn → xóa room khỏi memory
// ##########################################################################
async function leave(ws) {
    const roomId = ws.room;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    const entry = room.users.get(ws.userId);
    if (!entry) return;

    entry.connections--;
    entry.sockets.delete(ws);

    if (entry.connections === 0) {
        entry.lastOnline = Date.now();

        const onlineDuration = entry.lastOnline - entry.joinTime;

        await updateOnlineDuration(ws.userId, onlineDuration);

        room.users.delete(ws.userId);
    }

    if (room.users.size === 0) {
        rooms.delete(roomId);
    }

    ws.unsubscribe(roomId);
    ws.room = null;
}

// ##########################################################################
// # SEND FULL USER LIST TO ADMINS
// # - Build snapshot toàn bộ user trong room
// # - O(n) theo số user trong room
// ##########################################################################
function sendUsersToAdmins(roomId) {
    const room = rooms.get(roomId);
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

    const message = JSON.stringify(payload);

    for (const entry of room.users.values()) {
        if (entry.role === "admin") {
            for (const socket of entry.sockets) {
                socket.send(message);
            }
        }
    }
}


// ##########################################################################
// # UPDATE LAST ONLINE TO DATABASE 
// # - Gửi thông tin để server expressjs để cập nhật vào database
// ##########################################################################
async function updateOnlineDuration(userId, timestamp) {
    try {
        const response = await fetch("http://localhost:4000/api/v1/studytime", {
            method: "PATCH",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                userId,
                duration: timestamp
            })
        });


        console.log("Status:", response.status);

        const data = await response.json().catch(() => null);
        console.log("Response data:", data);

        if (response.ok) {
            console.log("Fetch thành công");
        } else {
            console.log("Fetch thất bại");
        }
    } catch (err) {
        console.error("Lỗi khi fetch:", err);
    }
}


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

        const current = ipConnections.get(ip) || 0;
        if (current >= MAX_PER_IP) {
            return new Response("Too many connections", { status: 429 });
        }

        if (server.upgrade(req, { data: { ip } })) {
            ipConnections.set(ip, current + 1);
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
                        join(ws, data.roomId, data.payload);
                        sendUsersToAdmins(data.roomId);
                        break;
                    }

                    // ##########################################################
                    // # MESSAGE
                    // # - Broadcast message tới toàn bộ room
                    // ##########################################################
                    case CLIENT_EVENTS.MESSAGE: {
                        if (!ws.room) return;

                        const room = rooms.get(ws.room);
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
                    // # REMOVE_USER
                    // # - Leave room
                    // # - Gửi lại full user list cho admin
                    // ##########################################################
                    case CLIENT_EVENTS.REMOVE_USER: {
                        if (!ws.room) return;
                        const roomId = ws.room;
                        leave(ws);
                        sendUsersToAdmins(roomId);
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
            if (ip) {
                const current = ipConnections.get(ip) || 1;
                if (current <= 1) ipConnections.delete(ip);
                else ipConnections.set(ip, current - 1);
            }

            if (ws.room) {
                const roomId = ws.room;
                leave(ws);
                sendUsersToAdmins(roomId);
            }

            console.log('Client disconnected')
        }
    }
});

console.log("websocket listening on port 3001");
