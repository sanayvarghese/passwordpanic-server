import { Server, ServerWebSocket } from "bun";
import axios from "axios";

interface Player {
  id: string;
  name: string;
  roomId: string;
  progress: {
    rulesCompleted: number;
    totalRules: number;
    password: string;
    ruleStates: RuleState[];
    allSolved: boolean;
    finishedAt: number;
    timeTaken: number;
    skipsUsed: number;
  };
  joinedAt: number;
}

interface RuleState {
  num: number;
  correct: boolean;
  unlocked: boolean;
  skipped: boolean;
}

interface Room {
  id: string;
  code: string;
  hostId: string;
  players: Map<string, Player>;
  gameStarted: boolean;
  gameEnded: boolean;
  createdAt: number;
  startedAt: number | null;
  timeLimit: number; // in milliseconds
  endReason: string | null; // 'time_up' | 'stopped' | null
  maxSkips: number; // max skips per player, default 2
}

const rooms = new Map<string, Room>();
const players = new Map<string, Player>();
const wsToPlayerId = new Map<ServerWebSocket<unknown>, string>();

// Generate a 6-character room code
function generateRoomCode(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// Get or create a room
function getOrCreateRoom(
  hostId: string,
  playerName: string,
  timeLimit: number = 60 * 60 * 1000,
  maxSkips: number = 2,
): Room {
  // Check if player already has a room
  const existingPlayer = players.get(hostId);
  if (existingPlayer && rooms.has(existingPlayer.roomId)) {
    return rooms.get(existingPlayer.roomId)!;
  }

  // Create new room
  let code = generateRoomCode();
  while (Array.from(rooms.values()).some((r) => r.code === code)) {
    code = generateRoomCode();
  }

  const room: Room = {
    id: crypto.randomUUID(),
    code,
    hostId,
    players: new Map(),
    gameStarted: false,
    gameEnded: false,
    createdAt: Date.now(),
    startedAt: null,
    timeLimit: timeLimit,
    endReason: null,
    maxSkips: maxSkips,
  };

  rooms.set(room.id, room);
  return room;
}

// Join a room by code
function joinRoomByCode(
  code: string,
  playerId: string,
  playerName: string,
): Room | null {
  const room = Array.from(rooms.values()).find((r) => r.code === code);
  if (!room || room.gameEnded) {
    return null;
  }

  return room;
}

// End game and send results
function endGame(room: Room, reason: "time_up" | "stopped" | "all_completed") {
  if (room.gameEnded) return;

  room.gameEnded = true;
  room.endReason = reason;

  // Calculate final times for all players
  const endTime = Date.now();
  const finalStats = Array.from(room.players.values())
    .filter((player) => player.id !== room.hostId)
    .map((player) => {
      // Time taken: from game start to completion (if completed) or to game end (if not completed)
      const timeTaken = room.startedAt
        ? (player.progress.finishedAt || endTime) - room.startedAt
        : 0;

      return {
        id: player.id,
        name: player.name,
        rulesCompleted: player.progress.rulesCompleted,
        totalRules: player.progress.totalRules,
        allSolved: player.progress.allSolved,
        timeTaken: timeTaken,
        finishedAt: player.progress.finishedAt,
        ruleStates: player.progress.ruleStates || [], // Include rule states for display
        skipsUsed: player.progress.skipsUsed || 0,
      };
    })
    .sort((a, b) => {
      // Sort by: completed first, then by rules completed, then by time
      if (a.allSolved && !b.allSolved) return -1;
      if (!a.allSolved && b.allSolved) return 1;
      if (a.rulesCompleted !== b.rulesCompleted)
        return b.rulesCompleted - a.rulesCompleted;
      return a.timeTaken - b.timeTaken;
    });

  // Broadcast game ended to all players
  broadcastToRoom(room.id, {
    type: "game_ended",
    reason: reason,
    finalStats: finalStats,
  });

  // Send final stats to host
  if (room.hostId) {
    sendToPlayer(room.hostId, {
      type: "game_ended",
      reason: reason,
      finalStats: finalStats,
    });
  }
}

// Broadcast to all players in a room
function broadcastToRoom(
  roomId: string,
  message: any,
  excludePlayerId?: string,
) {
  const room = rooms.get(roomId);
  if (!room) return;

  const messageStr = JSON.stringify(message);
  room.players.forEach((player, playerId) => {
    if (playerId !== excludePlayerId) {
      // Find WebSocket for this player
      wsToPlayerId.forEach((pid, ws) => {
        if (pid === playerId) {
          ws.send(messageStr);
        }
      });
    }
  });
}

// Send to specific player
function sendToPlayer(playerId: string, message: any) {
  const messageStr = JSON.stringify(message);
  wsToPlayerId.forEach((pid, ws) => {
    if (pid === playerId) {
      ws.send(messageStr);
    }
  });
}

// Get room stats for host
function getRoomStats(roomId: string) {
  const room = rooms.get(roomId);
  if (!room) return null;

  const nonHostPlayers = Array.from(room.players.values()).filter(
    (player) => player.id !== room.hostId,
  );

  const stats = nonHostPlayers.map((player) => {
    const ruleStates = player.progress.ruleStates || [];

    return {
      id: player.id,
      name: player.name,
      rulesCompleted: player.progress.rulesCompleted,
      totalRules: player.progress.totalRules,
      allSolved: player.progress.allSolved,
      joinedAt: player.joinedAt,
      finishedAt: player.progress.finishedAt,
      timeTaken: player.progress.timeTaken,
      ruleStates: [...ruleStates], // Create a copy to ensure it's included
      skipsUsed: player.progress.skipsUsed || 0,
    };
  });

  return {
    roomCode: room.code,
    gameStarted: room.gameStarted,
    gameEnded: room.gameEnded,
    players: stats,
    totalPlayers: nonHostPlayers.length,
    timeLimit: room.timeLimit,
    startedAt: room.startedAt,
    endReason: room.endReason,
    maxSkips: room.maxSkips,
  };
}

const port = Number(process.env.PORT) || Number(process.env.BUN_PORT) || 3001;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const server = Bun.serve({
  port,
  async fetch(req, server) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: corsHeaders,
      });
    }

    if (url.pathname === "/health") {
      return new Response("OK");
    }

    if (url.pathname === "/wordle") {
      let date = new Date();
      let year = date.getFullYear();
      let month = date.getMonth() + 1;
      let day = date.getDate();

      let url = `https://www.nytimes.com/svc/wordle/v2/${year}-${("0" + month).slice(-2)}-${("0" + day).slice(-2)}.json`;

      var res = await axios.get(url);
      return new Response(JSON.stringify(res.data), {
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
        },
      });
    }

    // Upgrade to WebSocket
    if (server.upgrade(req)) {
      return;
    }

    return new Response("Not Found", { status: 404 });
  },
  websocket: {
    open(ws) {
      console.log("WebSocket connection opened");
    },
    message(ws, message) {
      try {
        const data = JSON.parse(message.toString());
        const playerId = wsToPlayerId.get(ws);

        switch (data.type) {
          case "create_room": {
            const { playerName, timeLimit, maxSkips } = data;
            const newPlayerId = crypto.randomUUID();
            wsToPlayerId.set(ws, newPlayerId);

            // Convert minutes to milliseconds, default 60 minutes
            const timeLimitMs = timeLimit
              ? timeLimit * 60 * 1000
              : 60 * 60 * 1000;
            const skipCount = typeof maxSkips === "number" ? maxSkips : 2;
            const room = getOrCreateRoom(
              newPlayerId,
              playerName,
              timeLimitMs,
              skipCount,
            );
            const player: Player = {
              id: newPlayerId,
              name: playerName,
              roomId: room.id,
              progress: {
                rulesCompleted: 0,
                totalRules: 0,
                password: "",
                ruleStates: [],
                allSolved: false,
                finishedAt: null,
                timeTaken: 0,
                skipsUsed: 0,
              },
              joinedAt: Date.now(),
            };

            players.set(newPlayerId, player);
            room.players.set(newPlayerId, player);

            ws.send(
              JSON.stringify({
                type: "room_created",
                roomCode: room.code,
                playerId: newPlayerId,
                isHost: true,
                maxSkips: room.maxSkips,
              }),
            );

            // Send initial stats to host
            sendToPlayer(newPlayerId, {
              type: "room_stats",
              stats: getRoomStats(room.id),
            });
            break;
          }

          case "join_room": {
            const { roomCode, playerName } = data;
            const newPlayerId = crypto.randomUUID();
            wsToPlayerId.set(ws, newPlayerId);

            const room = joinRoomByCode(roomCode, newPlayerId, playerName);
            if (!room) {
              ws.send(
                JSON.stringify({
                  type: "join_failed",
                  message: "Room not found or game already ended",
                }),
              );
              break;
            }

            const player: Player = {
              id: newPlayerId,
              name: playerName,
              roomId: room.id,
              progress: {
                rulesCompleted: 0,
                totalRules: 0,
                password: "",
                ruleStates: [],
                allSolved: false,
                finishedAt: null,
                timeTaken: 0,
                skipsUsed: 0,
              },
              joinedAt: Date.now(),
            };

            players.set(newPlayerId, player);
            room.players.set(newPlayerId, player);

            ws.send(
              JSON.stringify({
                type: "room_joined",
                roomCode: room.code,
                playerId: newPlayerId,
                isHost: room.hostId === newPlayerId,
                gameStarted: room.gameStarted,
              }),
            );

            // Notify all players in room
            broadcastToRoom(room.id, {
              type: "player_joined",
              player: {
                id: player.id,
                name: player.name,
              },
            });

            // Send stats to host
            if (room.hostId) {
              sendToPlayer(room.hostId, {
                type: "room_stats",
                stats: getRoomStats(room.id),
              });
            }

            if (room.gameStarted && !room.gameEnded) {
              ws.send(
                JSON.stringify({
                  type: "game_started",
                  timeLimit: room.timeLimit,
                  startedAt: room.startedAt,
                  maxSkips: room.maxSkips,
                }),
              );
            }
            break;
          }

          case "start_game": {
            if (!playerId) break;
            const player = players.get(playerId);
            if (!player) break;

            const room = rooms.get(player.roomId);
            if (!room || room.hostId !== playerId) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  message: "Only the host can start the game",
                }),
              );
              break;
            }

            room.gameStarted = true;
            room.startedAt = Date.now();
            broadcastToRoom(room.id, {
              type: "game_started",
              timeLimit: room.timeLimit,
              startedAt: room.startedAt,
              maxSkips: room.maxSkips,
            });

            // Start timer to check for time limit
            setTimeout(() => {
              const currentRoom = rooms.get(room.id);
              if (
                currentRoom &&
                currentRoom.gameStarted &&
                !currentRoom.gameEnded
              ) {
                endGame(currentRoom, "time_up");
              }
            }, room.timeLimit);

            // Send stats to host
            sendToPlayer(playerId, {
              type: "room_stats",
              stats: getRoomStats(room.id),
            });
            break;
          }

          case "stop_game": {
            if (!playerId) break;
            const player = players.get(playerId);
            if (!player) break;

            const room = rooms.get(player.roomId);
            if (!room || room.hostId !== playerId) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  message: "Only the host can stop the game",
                }),
              );
              break;
            }

            if (!room.gameStarted || room.gameEnded) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  message: "Game is not running",
                }),
              );
              break;
            }

            endGame(room, "stopped");
            break;
          }

          case "reconnect": {
            const { playerId: reconnectPlayerId } = data;
            if (reconnectPlayerId && players.has(reconnectPlayerId)) {
              wsToPlayerId.set(ws, reconnectPlayerId);
              const player = players.get(reconnectPlayerId);
              if (player) {
                const room = rooms.get(player.roomId);
                if (room) {
                  ws.send(
                    JSON.stringify({
                      type: "reconnected",
                      roomCode: room.code,
                      playerName: player.name,
                      gameStarted: room.gameStarted,
                      gameEnded: room.gameEnded,
                      startedAt: room.startedAt,
                      timeLimit: room.timeLimit,
                      maxSkips: room.maxSkips,
                      skipsUsed: player.progress.skipsUsed || 0,
                      skippedRules: (player.progress.ruleStates || [])
                        .filter((r: RuleState) => r.skipped)
                        .map((r: RuleState) => r.num),
                    }),
                  );
                  // If host reconnected, send current stats
                  if (room.hostId === reconnectPlayerId) {
                    sendToPlayer(reconnectPlayerId, {
                      type: "room_stats",
                      stats: getRoomStats(room.id),
                    });
                  }
                }
              }
            }
            break;
          }

          case "update_progress": {
            if (!playerId) break;
            const player = players.get(playerId);
            if (!player) break;

            const room = rooms.get(player.roomId);
            if (!room || room.gameEnded) break; // Don't update if game ended

            const {
              rulesCompleted,
              totalRules,
              password,
              ruleStates,
              allSolved,
            } = data;

            // Preserve skipped flags from existing rule states
            const existingSkipped = new Map(
              (player.progress.ruleStates || [])
                .filter((r: RuleState) => r.skipped)
                .map((r: RuleState) => [r.num, true]),
            );
            const mergedRuleStates = ruleStates
              ? ruleStates.map((r: any) => ({
                  ...r,
                  skipped: existingSkipped.get(r.num) || r.skipped || false,
                }))
              : [];

            player.progress = {
              rulesCompleted,
              totalRules,
              password: password || "",
              ruleStates: mergedRuleStates,
              allSolved: allSolved || false,
              finishedAt: allSolved ? Date.now() : null,
              timeTaken:
                allSolved && room && room.startedAt
                  ? Date.now() - room.startedAt
                  : 0,
              skipsUsed: player.progress.skipsUsed || 0,
            };

            // Update room's player data
            room.players.set(playerId, player);

            // Check if ALL non-host players have completed - auto-end the game
            const nonHostPlayers = Array.from(room.players.values()).filter(
              (p) => p.id !== room.hostId,
            );
            const allPlayersCompleted =
              nonHostPlayers.length > 0 &&
              nonHostPlayers.every((p) => p.progress.allSolved);

            if (allPlayersCompleted) {
              endGame(room, "all_completed");
              break;
            }

            // Send updated stats to host
            if (room.hostId && room.hostId !== playerId) {
              const stats = getRoomStats(room.id);
              sendToPlayer(room.hostId, {
                type: "room_stats",
                stats: stats,
              });
            }
            break;
          }

          case "get_stats": {
            if (!playerId) break;
            const player = players.get(playerId);
            if (!player) break;

            const room = rooms.get(player.roomId);
            if (room && room.hostId === playerId) {
              sendToPlayer(playerId, {
                type: "room_stats",
                stats: getRoomStats(room.id),
              });
            }
            break;
          }

          case "skip_rule": {
            if (!playerId) break;
            const player = players.get(playerId);
            if (!player) break;

            const room = rooms.get(player.roomId);
            if (!room || !room.gameStarted || room.gameEnded) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  message: "Game is not running",
                }),
              );
              break;
            }

            const { ruleNum } = data;
            if (typeof ruleNum !== "number") break;

            // Check if player has skips remaining
            if ((player.progress.skipsUsed || 0) >= room.maxSkips) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  message: "No skips remaining",
                }),
              );
              break;
            }

            // Check if rule is already skipped
            const existingRule = (player.progress.ruleStates || []).find(
              (r: RuleState) => r.num === ruleNum,
            );
            if (existingRule && existingRule.skipped) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  message: "Rule already skipped",
                }),
              );
              break;
            }

            // Mark rule as skipped
            player.progress.skipsUsed = (player.progress.skipsUsed || 0) + 1;
            player.progress.ruleStates = (player.progress.ruleStates || []).map(
              (r: RuleState) =>
                r.num === ruleNum ? { ...r, skipped: true, correct: true } : r,
            );

            // If rule wasn't in ruleStates yet, add it
            if (
              !player.progress.ruleStates.find(
                (r: RuleState) => r.num === ruleNum,
              )
            ) {
              player.progress.ruleStates.push({
                num: ruleNum,
                correct: true,
                unlocked: true,
                skipped: true,
              });
            }

            // Update completed count
            const completedCount = player.progress.ruleStates.filter(
              (r: RuleState) => r.correct,
            ).length;
            player.progress.rulesCompleted = completedCount;

            // Check if all solved now
            if (
              player.progress.totalRules > 0 &&
              completedCount >= player.progress.totalRules
            ) {
              player.progress.allSolved = true;
              player.progress.finishedAt = Date.now();
              player.progress.timeTaken = room.startedAt
                ? Date.now() - room.startedAt
                : 0;
            }

            room.players.set(playerId, player);

            // Send confirmation back to player
            ws.send(
              JSON.stringify({
                type: "rule_skipped",
                ruleNum: ruleNum,
                skipsUsed: player.progress.skipsUsed,
                maxSkips: room.maxSkips,
              }),
            );

            // Check if all players completed
            const nonHostPlayers = Array.from(room.players.values()).filter(
              (p) => p.id !== room.hostId,
            );
            const allPlayersCompleted =
              nonHostPlayers.length > 0 &&
              nonHostPlayers.every((p) => p.progress.allSolved);

            if (allPlayersCompleted) {
              endGame(room, "all_completed");
              break;
            }

            // Send updated stats to host
            if (room.hostId && room.hostId !== playerId) {
              sendToPlayer(room.hostId, {
                type: "room_stats",
                stats: getRoomStats(room.id),
              });
            }
            break;
          }
        }
      } catch (error) {
        console.error("Error handling message:", error);
        ws.send(
          JSON.stringify({
            type: "error",
            message: "Invalid message format",
          }),
        );
      }
    },
    close(ws) {
      const playerId = wsToPlayerId.get(ws);
      if (playerId) {
        const player = players.get(playerId);
        if (player) {
          const room = rooms.get(player.roomId);
          if (room) {
            if (!room.gameStarted) {
              // Don't remove the HOST - they may be reconnecting (e.g. redirect from create to room URL)
              const isHost = room.hostId === playerId;
              if (!isHost) {
                room.players.delete(playerId);
                players.delete(playerId);

                broadcastToRoom(room.id, {
                  type: "player_left",
                  playerId: player.id,
                });

                if (room.hostId) {
                  sendToPlayer(room.hostId, {
                    type: "room_stats",
                    stats: getRoomStats(room.id),
                  });
                }

                if (room.players.size === 0) {
                  setTimeout(
                    () => {
                      const latestRoom = rooms.get(room.id);
                      if (
                        latestRoom &&
                        !latestRoom.gameStarted &&
                        latestRoom.players.size === 0
                      ) {
                        rooms.delete(room.id);
                      }
                    },
                    5 * 60 * 1000,
                  );
                }
              }
            }
            // If the game has started, we keep the player in the room so the host
            // can still see their last known progress; closing is treated as a disconnect.
          }
        }
        wsToPlayerId.delete(ws);
      }
      console.log("WebSocket connection closed");
    },
  },
});

console.log(`Server running on http://localhost:${server.port}`);

// --- Keep-alive mechanisms to prevent Render free-tier spin-down ---

// 1. WebSocket ping: Send a ping to every connected client every 30 seconds.
//    This keeps the WS connection alive and prevents proxy/load-balancer timeouts.
setInterval(() => {
  wsToPlayerId.forEach((_playerId, ws) => {
    try {
      ws.send(JSON.stringify({ type: "ping" }));
    } catch (e) {
      // Connection already dead, ignore
    }
  });
}, 30_000);

// 2. Self-ping: Hit our own /health endpoint every 10 minutes to prevent
//    Render's free tier from spinning down the service due to HTTP inactivity.
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_EXTERNAL_URL) {
  setInterval(
    async () => {
      try {
        await fetch(`${RENDER_EXTERNAL_URL}/health`);
        console.log("[keep-alive] Self-ping successful");
      } catch (e) {
        console.error("[keep-alive] Self-ping failed:", e);
      }
    },
    10 * 60 * 1000,
  ); // every 10 minutes
  console.log("[keep-alive] Self-ping enabled for Render");
}
