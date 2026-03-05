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
        maxPayloadLength: 3 * 1024 * 1024,
        // ##################################################################
        // # HANDLE INCOMING MESSAGE
        // ##################################################################
        async message(ws, raw) {
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
                        await roomManager.join(ws, data.roomId, data.payload);
                        if (data.roomId === 'global') {
                            roomManager.sendUsersToAdmins();
                        }
                        break;
                    }

                    // ##########################################################
                    // # MESSAGE
                    // # - Broadcast message tới toàn bộ room
                    // ##########################################################
                    case CLIENT_EVENTS.NEW_MESSAGE: {
                        if (!ws.rooms?.has(data.chatId)) return;
                        if (!data.chatId || !data.payload) return;

                        const { sender, message } = data.payload;
                        const receiverIds = data.members.filter((id) => id !== sender);

                        const payload = {
                            _id: crypto.randomUUID(),
                            type: CLIENT_EVENTS.NEW_MESSAGE,
                            chatId: data.chatId,
                            sender,
                            message
                        };

                        const serialized = JSON.stringify(payload);

                        ws.send(serialized);
                        ws.publish(data.chatId, serialized); // gửi cho members khác

                        for (const receiverId of receiverIds) {
                            // Chỉ gửi notification nếu receiver không còn trong room
                            const isInRoom = roomManager.isUserInRoom(data.chatId, receiverId);
                            if (isInRoom) continue;

                            const notificationForDb = {
                                _id: crypto.randomUUID(),
                                sender,
                                receiver: receiverId,
                                content: "New Message",
                                type: "new_message",
                                relatedId: `/messages/${data.chatId}`,
                            };

                            roomManager
                                .newNotification(ws, notificationForDb)
                                .catch(console.error);

                            const isOnline = roomManager.isUserInRoom("global", receiverId);
                            if (isOnline) {
                                roomManager.sendToUser("global", receiverId, payload);
                            }
                        }

                        roomManager
                            .newMessageForDB(ws, {
                                sender,
                                content: message.content,
                                attachments: message.attachments ?? [],
                                chatId: data.chatId,
                            })
                            .catch(console.error);

                        break;
                    }

                    // ##########################################################
                    // # START_TYPING / STOP_TYPING
                    // # - Chỉ forward tới members khác trong room (không gửi lại sender)
                    // # - Không lưu DB, không notification
                    // ##########################################################
                    case CLIENT_EVENTS.START_TYPING:
                    case CLIENT_EVENTS.STOP_TYPING: {
                        if (!data.chatId || !ws.rooms?.has(data.chatId)) return;
                        const payload = JSON.stringify({
                            type: data.type,
                            chatId: data.chatId,
                        });

                        ws.publish(data.chatId, payload);
                        break;
                    }

                    // ##########################################################
                    // # CHECK_STATUS
                    // # - Kiểm tra xem receiver có online hay không 
                    // ##########################################################
                    case CLIENT_EVENTS.CHECK_STATUS: {
                        if (!data.receiverId) return;
                        const isOnline = roomManager.isUserInRoom("global", data.receiverId);
                        ws.send(JSON.stringify({
                            type: CLIENT_EVENTS.CHECK_STATUS,
                            online_status: isOnline
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
                        if (!data.roomId || !ws.rooms?.has(data.roomId)) return;
                        if (!data.payload?.receiverId || !data.payload?.type) return;

                        const { receiverId, type } = data.payload;

                        roomManager.sendPremiumAlert(data.roomId, receiverId, {
                            _id: crypto.randomUUID(),
                            receiver: receiverId,
                            type,
                        });

                        break;
                    }


                    // ##########################################################
                    // # REMOVE_USER
                    // # - Leave room
                    // ##########################################################
                    case CLIENT_EVENTS.REMOVE_USER: {
                        if (!data.roomId || !ws.rooms?.has(data.roomId)) return;
                        const roomId = data.roomId;
                        roomManager.softLeave(ws, roomId);
                        break;
                    }
                }
            } catch (err) {
                console.error("Có lỗi xảy ra:", err);
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

            // Duyệt toàn bộ room mà socket này đang subscribe
            // [...ws.rooms] snapshot trước để tránh lỗi khi leave() xóa roomId khỏi ws.rooms trong lúc đang loop
            if (ws.rooms?.size > 0) {
                for (const roomId of [...ws.rooms]) {
                    roomManager.leave(ws, roomId)
                        .then(() => {
                            // Chỉ update admin khi có thay đổi ở global
                            if (roomId === "global") {
                                roomManager.sendUsersToAdmins();
                            }
                        })
                        .catch(console.error);
                }
            }

            console.log('Client disconnected')
        }
    }
});

console.log("websocket listening on port 3001");
