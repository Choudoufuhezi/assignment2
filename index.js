require("dotenv").config();

const express = require("express");
const mysql = require("mysql2/promise");
const session = require("express-session");
const MongoStore = require("connect-mongo").default;
const bcrypt = require("bcryptjs");

const app = express();

const db = mysql.createPool({
  host: process.env.MYSQL_HOST,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  port: process.env.MYSQL_PORT,
  ssl: {
    rejectUnauthorized: false
  }
});

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGO_URI })
}));

app.get("/", (req, res) => {
  if (req.session.user_id) {
    return res.redirect("/rooms");
  } else {
    return res.redirect("/login");
  }
});

function requireLogin(req, res, next) {
  if (!req.session.user_id) return res.redirect("/login");
  next();
}

async function addUsersToRoom(db, roomId, userIds) {
  for (let userId of userIds) {
    await db.execute(`
      INSERT IGNORE INTO room_user (user_id, room_id)
      VALUES (?, ?)
    `, [userId, roomId]);
  }
}

app.get("/signup", (req, res) => {
  res.send(`
    <form method="POST">
      <input name="email" placeholder="email"/><br>
      <input name="username" placeholder="username"/><br>
      <input name="password" type="password" placeholder="password"/><br>
      <button>Signup</button>
    </form>
  `);
});

app.post("/signup", async (req, res) => {
  const { email, username, password } = req.body;

  const hash = await bcrypt.hash(password, 10);

  const [result] = await db.execute(
    "INSERT INTO user (email, username, password_hash) VALUES (?, ?, ?)",
    [email, username, hash]
  );

  req.session.user_id = result.insertId;
  req.session.username = username;

  res.redirect("/rooms");
});

app.get("/login", (req, res) => {
  res.send(`
    <form method="POST">
      <input name="username" placeholder="username"/><br>
      <input name="password" type="password" placeholder="password"/><br>
      <button>Login</button>
    </form>
    <a href="/signup">
      <button type="button">Register</button>
    </a>
  `);
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  const [rows] = await db.execute(
    "SELECT * FROM user WHERE username = ?",
    [username]
  );

  if (rows.length === 0) return res.send("no user");

  const user = rows[0];

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.send("wrong password");

  req.session.user_id = user.user_id;
  req.session.username = user.username;

  res.redirect("/rooms");
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

app.get("/rooms", requireLogin, async (req, res) => {
  const [rows] = await db.execute(`
    SELECT r.room_id, r.name, COUNT(m.message_id) AS unread, (SELECT sent_datetime FROM message WHERE room_id = r.room_id ORDER BY message_id DESC LIMIT 1) AS last_message_date
    FROM room_user ru
    JOIN room r ON ru.room_id = r.room_id
    LEFT JOIN message m ON m.room_id = r.room_id AND m.message_id > IFNULL(ru.last_read_message_id, 0) AND m.user_id != ru.user_id
    WHERE ru.user_id = ?
    GROUP BY r.room_id
  `, [req.session.user_id]);

  const [name] = await db.execute( `
      SELECT user.username
      FROM user
      WHERE user.user_id = ?
    `, [req.session.user_id]);

  let html = `
    <h1>Hello, ${name[0].username}
    <h2>Rooms</h2>
    <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse;">
      <tr>
        <th>Room</th>
        <th>Last Message Date</th>
        <th>Unread</th>
      </tr>
  `;

  rows.forEach(r => {
    let dateText = "No messages";

    if (r.last_message_date) {
      const d = new Date(r.last_message_date);
      const month = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");

      const today = new Date();
      const msgDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      const todayDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const diffDays = Math.floor((todayDate - msgDate) / (1000 * 60 * 60 * 24));

      dateText = `${month}-${day} (${diffDays} day${diffDays !== 1 ? "s" : ""} ago)`;
    }

    html += `
      <tr>
        <td><a href="/rooms/${r.room_id}">${r.name}</a></td>
        <td>${dateText}</td>
        <td>${r.unread}</td>
      </tr>
    `;
  });

  html += `
    </table>
    <br><a href="/create-room">Create Room</a>
    <br><a href="/logout">Logout</a>
  `;
  
  res.send(html);
});

app.get("/create-room", requireLogin, async (req, res) => {

  const [users] = await db.execute(
    "SELECT user_id, username FROM user WHERE user_id != ?",
    [req.session.user_id]
  );

  let html = `
    <h2>Create Room</h2>
    <form method="POST">
      <input name="name" placeholder="group name"/><br><br>
      <b>Select users:</b><br>
  `;

  users.forEach(u => {
    html += `
      <input type="checkbox" name="members" value="${u.user_id}">
      ${u.username}<br>
    `;
  });

  html += `
      <br><button>Create Group</button>
    </form>
  `;

  res.send(html);
});

app.post("/create-room", requireLogin, async (req, res) => {
  const { name, members } = req.body;

  const [room] = await db.execute(
    "INSERT INTO room (name) VALUES (?)",
    [name]
  );

  const roomId = room.insertId;

  await db.execute(
    "INSERT INTO room_user (user_id, room_id) VALUES (?, ?)",
    [req.session.user_id, roomId]
  );

  if (members) {
    const memberList = Array.isArray(members) ? members : [members];
    await addUsersToRoom(db, roomId, memberList);
  }

  res.redirect(`/rooms/${roomId}`);
});

app.get("/rooms/:id", requireLogin, async (req, res) => {
  const roomId = req.params.id;

  const [check] = await db.execute(`
    SELECT * FROM room_user 
    WHERE user_id = ? AND room_id = ?
  `, [req.session.user_id, roomId]);

  if (check.length === 0) {
    return res.status(400).send("Unauthorized");
  }
  const [roomRows] = await db.execute(`
  SELECT name
  FROM room
  WHERE room_id = ? 
  `, [roomId]);

  const room_name = roomRows[0].name;

  const [maxRows] = await db.execute(`
  SELECT MAX(message_id) as max_id 
  FROM message 
  WHERE room_id = ?
`, [roomId]);


  const maxId = maxRows[0].max_id;

  await db.execute(`
  UPDATE room_user
  SET last_read_message_id = ?
  WHERE user_id = ? AND room_id = ?
`, [maxId, req.session.user_id, roomId]);

  const [messages] = await db.execute(`
  SELECT m.message_id, m.text, u.username, GROUP_CONCAT(CONCAT(e.name, ' x', rc.cnt) SEPARATOR ' ') AS emojis
  FROM message m
  JOIN user u ON m.user_id = u.user_id
  LEFT JOIN (
    SELECT 
      message_id,
      emoji_id,
      COUNT(*) as cnt
    FROM reaction
    GROUP BY message_id, emoji_id
  ) rc ON m.message_id = rc.message_id
  LEFT JOIN emoji e ON rc.emoji_id = e.emoji_id
  WHERE m.room_id = ?
  GROUP BY m.message_id
  ORDER BY m.message_id;
  `, [roomId]);

  let html = `
    <div style="display:flex; justify-content:space-between; align-items:center;">
      <h2>Room ${room_name}</h2>
      <a href="/rooms/${roomId}/invite">
        <button>Invite</button>
      </a>
    </div>
  `;

  messages.forEach(m => {
    const isMe = m.username === req.session.username;

    html += `
      <div style="
        display: flex;
        justify-content: ${isMe ? "flex-end" : "flex-start"};
        margin: 5px 0;
      ">
        <div style="
          background: ${isMe ? "#d1ffd6" : "#f0f0f0"};
          padding: 6px 10px;
          border-radius: 10px;
          max-width: 60%;
        ">
          <b>${m.username}</b>: ${m.text}
          ${m.emojis ? " [" + m.emojis + "]" : ""}

          <form method="POST" action="/react" style="display:inline;">
            <input type="hidden" name="message_id" value="${m.message_id}">
            <input type="hidden" name="room_id" value="${roomId}">
            <button name="emoji_id" value="1">👍</button>
            <button name="emoji_id" value="2">😂</button>
            <button name="emoji_id" value="3">❤️</button>
          </form>
        </div>
      </div>
    `;
  });

  html += `
    <form method="POST">
      <input name="text" />
      <button>Send</button>
    </form>
  `;

  html += `
    <br><a href="/rooms">Back</a>
  `;

  res.send(html);
});

app.post("/rooms/:id", requireLogin, async (req, res) => {
  const roomId = req.params.id;
  const { text } = req.body;
  const [check] = await db.execute(`
    SELECT * FROM room_user 
    WHERE user_id = ? AND room_id = ?
  `, [req.session.user_id, roomId]);

  if (check.length === 0) {
    return res.status(400).send("Unauthorized");
  }

  const [result] = await db.execute(
    "INSERT INTO message (room_id, user_id, text) VALUES (?, ?, ?)",
    [roomId, req.session.user_id, text]
  );

  const newMessageId = result.insertId;

  await db.execute(`
    UPDATE room_user
    SET last_read_message_id = ?
    WHERE user_id = ? AND room_id = ?
  `, [newMessageId, req.session.user_id, roomId]);


  res.redirect(`/rooms/${roomId}`);
});

app.post("/react", requireLogin, async (req, res) => {
  const { message_id, emoji_id, room_id } = req.body;

  const [rows] = await db.execute(`
    SELECT * FROM reaction
    WHERE message_id = ? AND emoji_id = ? AND user_id = ?
  `, [message_id, emoji_id, req.session.user_id]);

  if (rows.length > 0) {
    await db.execute(`
      DELETE FROM reaction
      WHERE message_id = ? AND emoji_id = ? AND user_id = ?
    `, [message_id, emoji_id, req.session.user_id]);
  } else {
    await db.execute(`
      INSERT INTO reaction (message_id, emoji_id, user_id)
      VALUES (?, ?, ?)
    `, [message_id, emoji_id, req.session.user_id]);
  }

  res.redirect(`/rooms/${room_id}`);
});

app.get("/rooms/:id/invite", requireLogin, async (req, res) => {
  const roomId = req.params.id;

  const [existing] = await db.execute(`
    SELECT user_id FROM room_user WHERE room_id = ?
  `, [roomId]);

  const existingIds = existing.map(u => u.user_id);

  const [users] = await db.execute(`
    SELECT user_id, username 
    FROM user 
    WHERE user_id NOT IN (${existingIds.length ? existingIds.join(",") : 0})
  `);

  let html = `
    <h2>Invite Users</h2>
    <form method="POST">
  `;

  users.forEach(u => {
    html += `
      <input type="checkbox" name="members" value="${u.user_id}">
      ${u.username}<br>
    `;
  });

  html += `
      <br><button>Invite</button>
    </form>
    <br><a href="/rooms/${roomId}">Back</a>
  `;

  res.send(html);
});

app.post("/rooms/:id/invite", requireLogin, async (req, res) => {
  const roomId = req.params.id;
  const { members } = req.body;

  if (members) {
    const memberList = Array.isArray(members) ? members : [members];
    await addUsersToRoom(db, roomId, memberList);
  }

  res.redirect(`/rooms/${roomId}`);
});

app.listen(3000, () => {
  console.log("http://localhost:3000");
});
