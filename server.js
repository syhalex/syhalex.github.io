const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

const app = express();
app.use(cors());
app.use(bodyParser.json());

// 确保上传目录存在
if (!fs.existsSync('./uploads')) {
    fs.mkdirSync('./uploads');
}

// --- Multer 配置 ---
const storage = multer.diskStorage({
    destination: './uploads/',
    filename: (req, file, cb) => {
        file.originalname = Buffer.from(file.originalname, "latin1").toString("utf8");
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 }
});

app.use('/uploads', express.static('uploads'));
app.use(express.static(__dirname));

// --- 数据库初始化 ---
const db = new sqlite3.Database('./database.sqlite', (err) => {
    if (err) {
        console.error("数据库连接错误: " + err.message);
    } else {
        console.log("成功连接到 SQLite 数据库");
        // 开启外键约束验证
        db.run('PRAGMA foreign_keys = ON');

        // 用户表
        db.run(`CREATE TABLE IF NOT EXISTS users (
            nickname TEXT PRIMARY KEY,
            password TEXT NOT NULL,
            bio TEXT DEFAULT '这个人很懒，什么都没写...',
            avatar TEXT
        )`);

        // 推文表
        db.run(`CREATE TABLE IF NOT EXISTS tweets (
            id TEXT PRIMARY KEY,
            author_uid TEXT,
            content TEXT,
            media TEXT,
            tags TEXT,
            timestamp TEXT,
            reactions_like INTEGER DEFAULT 0,
            reactions_confused INTEGER DEFAULT 0,
            reactions_omg INTEGER DEFAULT 0,
            FOREIGN KEY (author_uid) REFERENCES users(nickname) ON UPDATE CASCADE
        )`);

        // 评论表
        db.run(`CREATE TABLE IF NOT EXISTS comments (
            id TEXT PRIMARY KEY,
            tweet_id TEXT,
            author_uid TEXT,
            text TEXT,
            timestamp TEXT,
            FOREIGN KEY (tweet_id) REFERENCES tweets(id) ON DELETE CASCADE,
            FOREIGN KEY (author_uid) REFERENCES users(nickname) ON UPDATE CASCADE
        )`);
    }
});

// 工具函数：格式化推文供前端使用
// 对于未注册的用户（visitor_xxx开头），昵称显示为“访客”或默认前缀
function formatTweet(r, comments) {
    const isVisitor = r.author_uid && r.author_uid.startsWith('visitor_');
    const displayUser = r.registered_nick || (isVisitor ? '访客' : r.author_uid);

    return {
        id: r.id,
        user: displayUser,
        userAvatar: r.registered_avatar || null,
        author_uid: r.author_uid,
        content: r.content,
        media: JSON.parse(r.media || "[]"),
        mediaUrl: JSON.parse(r.media || "[]").length > 0 ? JSON.parse(r.media)[0].url : null,
        mediaType: JSON.parse(r.media || "[]").length > 0 ? JSON.parse(r.media)[0].type : null,
        tags: JSON.parse(r.tags || "[]"),
        timestamp: r.timestamp,
        reactions: {
            like: r.reactions_like,
            confused: r.reactions_confused,
            omg: r.reactions_omg
        },
        comments: comments.map(c => {
            const cIsVisitor = c.author_uid && c.author_uid.startsWith('visitor_');
            const cDisplayUser = c.registered_nick || (cIsVisitor ? '访客' : c.author_uid);
            return {
                id: c.id,
                user: cDisplayUser,
                avatar: c.registered_avatar || null,
                text: c.text,
                timestamp: c.timestamp
            };
        })
    };
}

// === 接口: Auth ===

// 注册
app.post('/api/register', (req, res) => {
    const { nickname, password, visitorId } = req.body;

    if (!nickname || !password) return res.status(400).json({ error: "昵称和密码不能为空" });
    if (!/^[a-zA-Z0-9_\-]+$/.test(nickname)) {
        return res.status(400).json({ error: "昵称只能包含大小写字母、数字、下划线和短横线" });
    }

    db.run(`INSERT INTO users (nickname, password) VALUES (?, ?)`, [nickname, password], function (err) {
        if (err) {
            if (err.message.includes('UNIQUE constraint failed')) {
                return res.status(409).json({ error: "昵称已被注册，请尝试其他昵称" });
            }
            return res.status(500).json({ error: err.message });
        }

        // 访客状态继承：如果传递了 visitorId，将之前的所有发帖和评论归入该注册账号名下
        if (visitorId) {
            db.run(`UPDATE tweets SET author_uid = ? WHERE author_uid = ?`, [nickname, visitorId]);
            db.run(`UPDATE comments SET author_uid = ? WHERE author_uid = ?`, [nickname, visitorId]);
        }

        res.status(201).json({ success: true, nickname });
    });
});

// 登录
app.post('/api/login', (req, res) => {
    const { nickname, password, visitorId } = req.body;

    db.get(`SELECT * FROM users WHERE nickname = ? AND password = ?`, [nickname, password], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(401).json({ error: "昵称或密码错误" });

        // 访客状态继承：如果传递了 visitorId，同理转移数据
        if (visitorId) {
            db.run(`UPDATE tweets SET author_uid = ? WHERE author_uid = ?`, [nickname, visitorId]);
            db.run(`UPDATE comments SET author_uid = ? WHERE author_uid = ?`, [nickname, visitorId]);
        }

        res.json({ success: true, user: { nickname: row.nickname, bio: row.bio, avatar: row.avatar } });
    });
});

// 校验昵称是否可用
app.get('/api/check-nickname', (req, res) => {
    const { nickname } = req.query;
    if (!nickname) return res.json({ available: false });
    db.get('SELECT nickname FROM users WHERE nickname = ?', [nickname], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ available: !row });
    });
});

// 获取个人资料
app.get('/api/profile', (req, res) => {
    const uid = req.query.uid;
    if (!uid) {
        return res.json({ nickname: "未登录", bio: "请先登录或注册", avatar: null });
    }

    db.get(`SELECT nickname, bio, avatar FROM users WHERE nickname = ?`, [uid], (err, row) => {
        if (err || !row) {
            // 在 users 表找不到，说明是未注册访客
            res.json({ nickname: "访客账户 (未注册)", bio: "发帖记录已暂时保存在当前浏览器。注册或登录以永久保存和同步您的数据。", avatar: null, isVisitor: true });
        } else {
            res.json({ ...row, isVisitor: false });
        }
    });
});

// 更新个人资料
app.post('/api/profile', upload.single('avatar'), (req, res) => {
    const { uid, bio, newNickname } = req.body;
    if (!uid) return res.status(401).json({ error: "Unauthorized" });

    db.get(`SELECT nickname FROM users WHERE nickname = ?`, [uid], (err, row) => {
        if (err || !row) return res.status(403).json({ error: "访客不能修改资料，请先注册" });

        let updates = [];
        let params = [];
        if (newNickname && newNickname !== uid) {
            if (!/^[a-zA-Z0-9_\-]+$/.test(newNickname)) {
                return res.status(400).json({ error: "昵称只能包含大小写字母、数字、下划线和短横线" });
            }
            updates.push("nickname = ?");
            params.push(newNickname);
        }
        if (bio !== undefined) {
            updates.push("bio = ?");
            params.push(bio);
        }
        if (req.file) {
            updates.push("avatar = ?");
            params.push(`http://localhost:5000/uploads/${req.file.filename}`);
        }

        if (updates.length > 0) {
            params.push(uid);
            db.run(`UPDATE users SET ${updates.join(', ')} WHERE nickname = ?`, params, function (err) {
                if (err) {
                    if (err.message.includes('UNIQUE constraint failed')) {
                        return res.status(409).json({ error: "昵称已被占用" });
                    }
                    return res.status(500).json({ error: err.message });
                }
                const targetUid = (newNickname && newNickname !== uid) ? newNickname : uid;
                db.get(`SELECT nickname, bio, avatar FROM users WHERE nickname = ?`, [targetUid], (err, finalRow) => {
                    res.json({ ...finalRow, isVisitor: false });
                });
            });
        } else {
            db.get(`SELECT nickname, bio, avatar FROM users WHERE nickname = ?`, [uid], (err, finalRow) => {
                res.json({ ...finalRow, isVisitor: false });
            });
        }
    });
});

// 注销账号
app.delete('/api/profile', (req, res) => {
    const { uid } = req.query;
    if (!uid) return res.status(401).json({ error: "Unauthorized" });

    // 先删除评论，再删除推文，最后删除用户
    db.serialize(() => {
        db.run(`DELETE FROM comments WHERE author_uid = ?`, [uid]);
        db.run(`DELETE FROM tweets WHERE author_uid = ?`, [uid]);
        db.run(`DELETE FROM users WHERE nickname = ?`, [uid], function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
    });
});

// === 接口: 推文 ===

// 获取推文列表 (带 Search 和 JOIN 获取最新头像昵称)
app.get('/api/tweets', (req, res) => {
    const { search } = req.query;
    let query = `
        SELECT t.*, u.nickname AS registered_nick, u.avatar AS registered_avatar 
        FROM tweets t 
        LEFT JOIN users u ON t.author_uid = u.nickname 
        ORDER BY t.id DESC
    `;
    let params = [];

    if (search) {
        query = `
            SELECT t.*, u.nickname AS registered_nick, u.avatar AS registered_avatar 
            FROM tweets t 
            LEFT JOIN users u ON t.author_uid = u.nickname 
            WHERE t.content LIKE ? OR t.author_uid LIKE ? OR u.nickname LIKE ?
            ORDER BY t.id DESC
        `;
        const q = `%${search}%`;
        params = [q, q, q];
    }

    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });

        db.all(`
            SELECT c.*, u.nickname AS registered_nick, u.avatar AS registered_avatar 
            FROM comments c 
            LEFT JOIN users u ON c.author_uid = u.nickname 
            ORDER BY c.id ASC
        `, [], (err, cmts) => {
            if (err) return res.status(500).json({ error: err.message });

            const commentsByTweet = {};
            cmts.forEach(c => {
                if (!commentsByTweet[c.tweet_id]) commentsByTweet[c.tweet_id] = [];
                // Frontend unshifts comments to show latest on top, we return newest first or let frontend handle it
                // Actually, original code unshifts newly created comments but doesn't change order when fetching.
                // Let's keep newest first.
                commentsByTweet[c.tweet_id].unshift(c);
            });

            const formatted = rows.map(r => formatTweet(r, commentsByTweet[r.id] || []));
            res.json(formatted);
        });
    });
});

// 发布推文
app.post('/api/tweets', upload.array('files', 9), (req, res) => {
    const { uid, content, tags } = req.body;
    if (!uid) return res.status(400).json({ error: "No user ID" });

    const media = [];
    if (req.files && req.files.length > 0) {
        req.files.forEach(file => {
            const url = `http://localhost:5000/uploads/${file.filename}`;
            const ext = path.extname(file.originalname).toLowerCase();
            const type = ['.mp4', '.webm', '.ogg', '.mov'].includes(ext) ? 'video' : 'image';
            media.push({ url, type });
        });
    }

    const id = Date.now().toString();
    const tagsArr = tags ? tags.split(/[,，]/).map(t => t.trim()).filter(t => t) : [];
    const timestamp = new Date().toLocaleString();

    db.run(`INSERT INTO tweets (id, author_uid, content, media, tags, timestamp) VALUES (?, ?, ?, ?, ?, ?)`,
        [id, uid, content, JSON.stringify(media), JSON.stringify(tagsArr), timestamp], function (err) {
            if (err) return res.status(500).json({ error: err.message });

            // 返回新建的推文
            db.get(`SELECT t.*, u.nickname AS registered_nick, u.avatar AS registered_avatar FROM tweets t LEFT JOIN users u ON t.author_uid = u.nickname WHERE t.id = ?`, [id], (err, row) => {
                if (err || !row) return res.status(500).json({ error: "Server error" });
                res.status(201).json(formatTweet(row, []));
            });
        });
});

// 获取单条推文详情
app.get('/api/tweets/:id', (req, res) => {
    db.get(`SELECT t.*, u.nickname AS registered_nick, u.avatar AS registered_avatar FROM tweets t LEFT JOIN users u ON t.author_uid = u.nickname WHERE t.id = ?`, [req.params.id], (err, r) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!r) return res.status(404).json({ error: "Not found" });

        db.all(`SELECT c.*, u.nickname AS registered_nick, u.avatar AS registered_avatar FROM comments c LEFT JOIN users u ON c.author_uid = u.nickname WHERE c.tweet_id = ? ORDER BY c.id DESC`, [r.id], (err, cmts) => {
            res.json(formatTweet(r, cmts));
        });
    });
});

// 互动
app.post('/api/tweets/:id/react', (req, res) => {
    const { type, action } = req.body;
    if (!['like', 'confused', 'omg'].includes(type)) return res.status(400).json({ error: "Invalid reaction type" });

    const col = `reactions_${type}`;
    db.get(`SELECT ${col} FROM tweets WHERE id = ?`, [req.params.id], (err, row) => {
        if (err || !row) return res.status(404).json({ error: "Not found" });

        let current = row[col];
        if (action === 'add') current++;
        else if (action === 'remove' && current > 0) current--;

        db.run(`UPDATE tweets SET ${col} = ? WHERE id = ?`, [current, req.params.id], function (err) {
            if (err) return res.status(500).json({ error: err.message });

            db.get(`SELECT t.*, u.nickname AS registered_nick, u.avatar AS registered_avatar FROM tweets t LEFT JOIN users u ON t.author_uid = u.nickname WHERE t.id = ?`, [req.params.id], (err, r) => {
                if (err || !r) return res.status(500).json({ error: "Error fetching" });
                db.all(`SELECT c.*, u.nickname AS registered_nick, u.avatar AS registered_avatar FROM comments c LEFT JOIN users u ON c.author_uid = u.nickname WHERE c.tweet_id = ? ORDER BY c.id DESC`, [req.params.id], (err, cmts) => {
                    res.json(formatTweet(r, cmts));
                });
            });
        });
    });
});

// 发布评论
app.post('/api/tweets/:id/comment', (req, res) => {
    const { text, uid } = req.body;
    if (!uid) return res.status(400).json({ error: "No user ID" });

    db.get(`SELECT id FROM tweets WHERE id = ?`, [req.params.id], (err, row) => {
        if (err || !row) return res.status(404).json({ error: "Not found" });

        const cid = Date.now().toString();
        const timestamp = new Date().toLocaleString();

        db.run(`INSERT INTO comments (id, tweet_id, author_uid, text, timestamp) VALUES (?, ?, ?, ?, ?)`,
            [cid, req.params.id, uid, text, timestamp], function (err) {
                if (err) return res.status(500).json({ error: err.message });

                db.get(`SELECT t.*, u.nickname AS registered_nick, u.avatar AS registered_avatar FROM tweets t LEFT JOIN users u ON t.author_uid = u.nickname WHERE t.id = ?`, [req.params.id], (err, r) => {
                    if (err || !r) return res.status(500).json({ error: "Error fetching" });
                    db.all(`SELECT c.*, u.nickname AS registered_nick, u.avatar AS registered_avatar FROM comments c LEFT JOIN users u ON c.author_uid = u.nickname WHERE c.tweet_id = ? ORDER BY c.id DESC`, [req.params.id], (err, cmts) => {
                        res.json(formatTweet(r, cmts));
                    });
                });
            });
    });
});

const PORT = 5000;
app.listen(PORT, () => {
    console.log(`服务器运行在: http://localhost:${PORT}`);
});