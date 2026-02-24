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
            avatar TEXT,
            banner TEXT
        )`);

        // 安全添加 banner 列（如果表已存在）
        db.run(`ALTER TABLE users ADD COLUMN banner TEXT`, (e) => { });

        // 推文表
        db.run(`CREATE TABLE IF NOT EXISTS tweets (
            id TEXT PRIMARY KEY,
            author_uid TEXT,
            content TEXT,
            media TEXT,
            tags TEXT,
            timestamp TEXT,
            reactions_like TEXT DEFAULT '[]',
            reactions_confused TEXT DEFAULT '[]',
            reactions_omg TEXT DEFAULT '[]',
            FOREIGN KEY (author_uid) REFERENCES users(nickname) ON UPDATE CASCADE
        )`);

        // 评论表
        db.run(`CREATE TABLE IF NOT EXISTS comments (
            id TEXT PRIMARY KEY,
            tweet_id TEXT,
            author_uid TEXT,
            text TEXT,
            timestamp TEXT,
            parent_id TEXT DEFAULT NULL,
            likes TEXT DEFAULT '[]',
            FOREIGN KEY (tweet_id) REFERENCES tweets(id) ON DELETE CASCADE,
            FOREIGN KEY (author_uid) REFERENCES users(nickname) ON UPDATE CASCADE
        )`, (err) => {
            if (!err) {
                // Try to add new columns to existing table, ignoring errors if they already exist
                db.run(`ALTER TABLE comments ADD COLUMN parent_id TEXT DEFAULT NULL`, (e) => { });
                db.run(`ALTER TABLE comments ADD COLUMN likes TEXT DEFAULT '[]'`, (e) => { });
            }
        });

        // 收藏表
        db.run(`CREATE TABLE IF NOT EXISTS bookmarks (
            user_id TEXT NOT NULL,
            tweet_id TEXT NOT NULL,
            timestamp TEXT,
            PRIMARY KEY (user_id, tweet_id),
            FOREIGN KEY (tweet_id) REFERENCES tweets(id) ON DELETE CASCADE
        )`);
    }
});

// 辅助函数：解析反应数组。兼容旧的整数格式，如果解析失败或为数字，则返回空数组。
function parseReactions(data) {
    if (!data) return [];
    if (!isNaN(data) && !isNaN(parseFloat(data))) return [];
    try {
        const arr = JSON.parse(data);
        return Array.isArray(arr) ? arr : [];
    } catch (e) {
        return [];
    }
}

// 辅助函数：获取反应数量。兼容旧的整数和新的数组格式。
function getReactionCount(data) {
    if (!data) return 0;
    if (!isNaN(data) && !isNaN(parseFloat(data))) return parseInt(data, 10);
    try {
        const arr = JSON.parse(data);
        return Array.isArray(arr) ? arr.length : 0;
    } catch (e) {
        return 0;
    }
}

// 工具函数：格式化推文供前端使用
// 对于未注册的用户（visitor_xxx开头），昵称显示为“访客”或默认前缀
function formatTweet(r, comments) {
    const isVisitor = r.author_uid && r.author_uid.startsWith('visitor_');
    const displayUser = r.registered_nick || (isVisitor ? '访客' : r.author_uid);

    // 解析二级评论
    const repliesMap = {};
    // 第一次遍历：筛选出二级评论并按主评论ID分组
    comments.forEach(c => {
        if (c.parent_id) {
            if (!repliesMap[c.parent_id]) repliesMap[c.parent_id] = [];
            const cIsVisitor = c.author_uid && c.author_uid.startsWith('visitor_');
            const cDisplayUser = c.registered_nick || (cIsVisitor ? '访客' : c.author_uid);
            repliesMap[c.parent_id].push({
                id: c.id,
                user: cDisplayUser,
                author_uid: c.author_uid,
                avatar: c.registered_avatar || null,
                text: c.text,
                timestamp: c.timestamp,
                likes: parseReactions(c.likes)
            });
        }
    });

    // 第二次遍历：构建一级评论列表，并将对应的二级评论挂载在 replies 字段
    const formattedComments = comments
        .filter(c => !c.parent_id)
        .map(c => {
            const cIsVisitor = c.author_uid && c.author_uid.startsWith('visitor_');
            const cDisplayUser = c.registered_nick || (cIsVisitor ? '访客' : c.author_uid);
            return {
                id: c.id,
                user: cDisplayUser,
                author_uid: c.author_uid,
                avatar: c.registered_avatar || null,
                text: c.text,
                timestamp: c.timestamp,
                likes: parseReactions(c.likes),
                replies: (repliesMap[c.id] || []).reverse() // 将最新的逆序回正，变成正常阅读顺序
            };
        });

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
            like: getReactionCount(r.reactions_like),
            confused: getReactionCount(r.reactions_confused),
            omg: getReactionCount(r.reactions_omg)
        },
        reactionUsers: {
            like: parseReactions(r.reactions_like),
            confused: parseReactions(r.reactions_confused),
            omg: parseReactions(r.reactions_omg)
        },
        comments: formattedComments
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
        if (!row) return res.status(401).json({ error: "昵称不存在或密码错误" });

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
        return res.json({ nickname: "未登录", bio: "请先登录或注册", avatar: null, banner: null });
    }

    db.get(`SELECT nickname, bio, avatar, banner FROM users WHERE nickname = ?`, [uid], (err, row) => {
        if (err || !row) {
            res.json({ nickname: "访客账户 (未注册)", bio: "发帖记录已暂时保存在当前浏览器。注册或登录以永久保存和同步您的数据。", avatar: null, banner: null, isVisitor: true });
        } else {
            res.json({ ...row, isVisitor: false });
        }
    });
});

// 更新个人资料
app.post('/api/profile', upload.fields([{ name: 'avatar', maxCount: 1 }, { name: 'banner', maxCount: 1 }]), (req, res) => {
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
        if (req.files && req.files['avatar'] && req.files['avatar'][0]) {
            updates.push("avatar = ?");
            params.push(`http://localhost:5000/uploads/${req.files['avatar'][0].filename}`);
        }
        if (req.files && req.files['banner'] && req.files['banner'][0]) {
            updates.push("banner = ?");
            params.push(`http://localhost:5000/uploads/${req.files['banner'][0].filename}`);
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
                db.get(`SELECT nickname, bio, avatar, banner FROM users WHERE nickname = ?`, [targetUid], (err, finalRow) => {
                    res.json({ ...finalRow, isVisitor: false });
                });
            });
        } else {
            db.get(`SELECT nickname, bio, avatar, banner FROM users WHERE nickname = ?`, [uid], (err, finalRow) => {
                res.json({ ...finalRow, isVisitor: false });
            });
        }
    });
});

// 注销账号
app.delete('/api/profile', (req, res) => {
    const { uid } = req.query;
    if (!uid) return res.status(401).json({ error: "Unauthorized" });

    // 先删除收藏、评论，再删除推文，最后删除用户
    db.serialize(() => {
        db.run(`DELETE FROM bookmarks WHERE user_id = ?`, [uid]);
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

// 修改推文
app.put('/api/tweets/:id', upload.array('files', 9), (req, res) => {
    const { uid, content, tags } = req.body;
    const tweetId = req.params.id;

    if (!uid) return res.status(401).json({ error: "Unauthorized" });

    db.get(`SELECT author_uid, media FROM tweets WHERE id = ?`, [tweetId], (err, row) => {
        if (err || !row) return res.status(404).json({ error: "Not found" });
        if (row.author_uid !== uid) return res.status(403).json({ error: "No permission" });

        let mediaStr = row.media;

        // 如果有新上传的文件，则完全替换原媒体；如果不传文件，保持原样。如果传了特定的清空标志可另外处理，不过目前简化为：如果重新选择了文件，就替换。
        if (req.files && req.files.length > 0) {
            const media = [];
            req.files.forEach(file => {
                const url = `http://localhost:5000/uploads/${file.filename}`;
                const ext = path.extname(file.originalname).toLowerCase();
                const type = ['.mp4', '.webm', '.ogg', '.mov'].includes(ext) ? 'video' : 'image';
                media.push({ url, type });
            });
            mediaStr = JSON.stringify(media);

            // 可选：在这里删除旧文件以节省空间。当前版本暂时只修改数据库。
        }

        const tagsArr = tags ? tags.split(/[,，]/).map(t => t.trim()).filter(t => t) : [];
        const timestamp = new Date().toLocaleString(); // 记录新的编辑时间

        // 追加一个特殊标志标识编辑过，利用原有的 timestamp 我们可以将其修改为带标记的字符串
        // "original_timestamp|edited_timestamp" 这种格式可以在前端解析
        // 为保持简单我们可以让前端处理 `edited_${timestamp}` 或者直接在表结构加edit_time（不过不要轻易改表结构）
        // 这里就直接覆盖 timestamp 字段就行了，前端解析如果满足需要再特殊处理

        db.run(`UPDATE tweets SET content = ?, tags = ?, media = ?, timestamp = ? WHERE id = ?`,
            [content, JSON.stringify(tagsArr), mediaStr, `编于: ${timestamp}`, tweetId], function (err) {
                if (err) return res.status(500).json({ error: err.message });

                db.get(`SELECT t.*, u.nickname AS registered_nick, u.avatar AS registered_avatar FROM tweets t LEFT JOIN users u ON t.author_uid = u.nickname WHERE t.id = ?`, [tweetId], (err, row) => {
                    if (err || !row) return res.status(500).json({ error: "Server error" });
                    res.json(formatTweet(row, []));
                });
            });
    });
});

// 删除推文
app.delete('/api/tweets/:id', (req, res) => {
    const { uid } = req.query;
    const tweetId = req.params.id;

    if (!uid) return res.status(401).json({ error: "Unauthorized" });

    db.get(`SELECT author_uid, media FROM tweets WHERE id = ?`, [tweetId], (err, row) => {
        if (err || !row) return res.status(404).json({ error: "Not found" });
        if (row.author_uid !== uid) return res.status(403).json({ error: "No permission" });

        // 删除外键关联和推文。SQLite 配置了 ON DELETE CASCADE，所以会自动删除 comments 和 bookmarks
        db.run(`DELETE FROM tweets WHERE id = ?`, [tweetId], (err) => {
            if (err) return res.status(500).json({ error: err.message });

            // 删除物理文件 (可选项，避免垃圾数据)
            try {
                const mediaArr = JSON.parse(row.media || "[]");
                mediaArr.forEach(m => {
                    if (m.url.startsWith('http://localhost:5000/uploads/')) {
                        const filename = m.url.split('/').pop();
                        const fp = path.join('./uploads', filename);
                        if (fs.existsSync(fp)) fs.unlinkSync(fp);
                    }
                });
            } catch (e) { console.error("Error deleting files:", e); }

            res.json({ success: true });
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
    const { uid, type } = req.body;

    // 权限校验：缺少uid或是访客账号则拦截
    if (!uid || uid.startsWith('visitor_')) {
        return res.status(401).json({ error: "Unauthorized: only logged-in users can react." });
    }

    if (!['like', 'confused', 'omg'].includes(type)) {
        return res.status(400).json({ error: "Invalid reaction type" });
    }

    const col = `reactions_${type}`;
    db.get(`SELECT ${col} FROM tweets WHERE id = ?`, [req.params.id], (err, row) => {
        if (err || !row) return res.status(404).json({ error: "Not found" });

        let userIds = parseReactions(row[col]);
        const userIndex = userIds.indexOf(uid);

        // 如果用户已经在集合中，则执行取消操作（移除该用户）；
        // 如果不在，则执行点赞操作（加入该用户）
        if (userIndex > -1) {
            userIds.splice(userIndex, 1);
        } else {
            userIds.push(uid);
        }

        const newColValue = JSON.stringify(userIds);

        db.run(`UPDATE tweets SET ${col} = ? WHERE id = ?`, [newColValue, req.params.id], function (err) {
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
    const { text, uid, parent_id } = req.body;
    if (!uid) return res.status(400).json({ error: "No user ID" });

    db.get(`SELECT id FROM tweets WHERE id = ?`, [req.params.id], (err, row) => {
        if (err || !row) return res.status(404).json({ error: "Not found" });

        const cid = Date.now().toString();
        const timestamp = new Date().toLocaleString();

        db.run(`INSERT INTO comments (id, tweet_id, author_uid, text, timestamp, parent_id) VALUES (?, ?, ?, ?, ?, ?)`,
            [cid, req.params.id, uid, text, timestamp, parent_id || null], function (err) {
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

// 给评论点赞
app.post('/api/comments/:id/like', (req, res) => {
    const { uid } = req.body;

    // 权限校验：缺少uid或是访客账号则拦截
    if (!uid || uid.startsWith('visitor_')) {
        return res.status(401).json({ error: "Unauthorized: only logged-in users can like comments." });
    }

    db.get(`SELECT likes FROM comments WHERE id = ?`, [req.params.id], (err, row) => {
        if (err || !row) return res.status(404).json({ error: "Comment not found" });

        let userIds = parseReactions(row.likes);
        const userIndex = userIds.indexOf(uid);

        let action = '';
        if (userIndex > -1) {
            userIds.splice(userIndex, 1);
            action = 'remove';
        } else {
            userIds.push(uid);
            action = 'add';
        }

        const newLikesValue = JSON.stringify(userIds);

        db.run(`UPDATE comments SET likes = ? WHERE id = ?`, [newLikesValue, req.params.id], function (err) {
            if (err) return res.status(500).json({ error: err.message });
            // 返回新的点赞数和用户列表供前端更新
            res.json({ success: true, action: action, likesCount: userIds.length, likesUsers: userIds });
        });
    });
});

// 收藏/取消收藏
app.post('/api/tweets/:id/bookmark', (req, res) => {
    const { uid } = req.body;
    if (!uid || uid.startsWith('visitor_')) {
        return res.status(401).json({ error: "Unauthorized: only logged-in users can bookmark." });
    }

    db.get(`SELECT * FROM bookmarks WHERE user_id = ? AND tweet_id = ?`, [uid, req.params.id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });

        if (row) {
            // 取消收藏
            db.run(`DELETE FROM bookmarks WHERE user_id = ? AND tweet_id = ?`, [uid, req.params.id], (err) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ success: true, bookmarked: false });
            });
        } else {
            // 添加收藏
            const ts = new Date().toLocaleString();
            db.run(`INSERT INTO bookmarks (user_id, tweet_id, timestamp) VALUES (?, ?, ?)`, [uid, req.params.id, ts], (err) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ success: true, bookmarked: true });
            });
        }
    });
});

// 获取用户收藏的推文列表
app.get('/api/bookmarks', (req, res) => {
    const { uid } = req.query;
    if (!uid) return res.status(400).json({ error: "Missing uid" });

    db.all(`SELECT b.tweet_id, b.timestamp AS bookmark_time, t.*, u.nickname AS registered_nick, u.avatar AS registered_avatar 
            FROM bookmarks b 
            JOIN tweets t ON b.tweet_id = t.id 
            LEFT JOIN users u ON t.author_uid = u.nickname 
            WHERE b.user_id = ? 
            ORDER BY b.timestamp DESC`, [uid], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });

        const tweets = rows.map(r => {
            return {
                ...formatTweet(r, []),
                bookmark_time: r.bookmark_time
            };
        });
        res.json(tweets);
    });
});

const PORT = 5000;
app.listen(PORT, () => {
    console.log(`服务器运行在: http://localhost:${PORT}`);
});