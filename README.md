# PasswordPanic Multiplayer Server

This is the Bun server for the PasswordPanic multiplayer game.

## Prerequisites

- [Bun](https://bun.sh/) installed on your system

## Installation

```bash
cd server
bun install
```

## Running the Server

```bash
bun run dev
```

The server will start on `http://localhost:3001` and listen for WebSocket connections.

## API

The server uses WebSocket for real-time communication. All messages are JSON formatted.

### Message Types

#### Client → Server

- `create_room`: Create a new game room

  ```json
  {
    "type": "create_room",
    "playerName": "Player Name"
  }
  ```

- `join_room`: Join an existing room by code

  ```json
  {
    "type": "join_room",
    "roomCode": "ABC123",
    "playerName": "Player Name"
  }
  ```

- `start_game`: Start the game (host only)

  ```json
  {
    "type": "start_game"
  }
  ```

- `update_progress`: Update player progress

  ```json
  {
    "type": "update_progress",
    "rulesCompleted": 5,
    "totalRules": 20,
    "password": "",
    "ruleStates": [...],
    "allSolved": false
  }
  ```

- `get_stats`: Request room statistics (host only)
  ```json
  {
    "type": "get_stats"
  }
  ```

#### Server → Client

- `room_created`: Room successfully created
- `room_joined`: Successfully joined a room
- `join_failed`: Failed to join room
- `game_started`: Game has started
- `room_stats`: Room statistics update
- `player_joined`: A new player joined the room
- `player_left`: A player left the room
- `error`: Error message
