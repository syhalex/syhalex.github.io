const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

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
        // 解决中文文件名乱码问题
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

// --- 数据存储 ---
let tweets = [];
let userProfile = {
    nickname: "新用户",
    bio: "这个人很懒，什么都没写...",
    avatar: null
};

// --- 接口: 获取/更新 个人资料 ---
app.get('/api/profile', (req, res) => res.json(userProfile));
app.post('/api/profile', upload.single('avatar'), (req, res) => {
    const { nickname, bio } = req.body;
    if (nickname) userProfile.nickname = nickname;
    if (bio) userProfile.bio = bio;
    if (req.file) userProfile.avatar = `http://localhost:5000/uploads/${req.file.filename}`;
    res.json(userProfile);
});

// --- 接口: 发布推文 ---
app.post('/api/tweets', upload.array('files', 9), (req, res) => {
    const { content, tags } = req.body;

    // 构建多媒体数组
    const media = [];
    if (req.files && req.files.length > 0) {
        req.files.forEach(file => {
            const url = `http://localhost:5000/uploads/${file.filename}`;
            const ext = path.extname(file.originalname).toLowerCase();
            const type = ['.mp4', '.webm', '.ogg', '.mov'].includes(ext) ? 'video' : 'image';
            media.push({ url, type });
        });
    }

    const newTweet = {
        id: Date.now().toString(), // 转为字符串方便比较
        user: userProfile.nickname,
        userAvatar: userProfile.avatar,
        content: content,
        media: media,              // 多媒体数组
        mediaUrl: media.length > 0 ? media[0].url : null,   // 兼容旧字段
        mediaType: media.length > 0 ? media[0].type : null,  // 兼容旧字段
        tags: tags ? tags.split(/[,，]/).map(t => t.trim()).filter(t => t) : [],
        timestamp: new Date().toLocaleString(),
        reactions: {
            like: 0,
            confused: 0,
            omg: 0
        },
        comments: []
    };

    tweets.unshift(newTweet);
    res.status(201).json(newTweet);
});

// --- 接口: 获取推文列表 ---
app.get('/api/tweets', (req, res) => {
    const { search } = req.query;
    let filteredTweets = [...tweets];

    if (search) {
        const query = search.toLowerCase();
        filteredTweets = filteredTweets.filter(t =>
            (t.content && t.content.toLowerCase().includes(query)) ||
            (t.user && t.user.toLowerCase().includes(query))
        );
    }
    res.json(filteredTweets);
});

// === 接口: 获取单条推文详情 ===
app.get('/api/tweets/:id', (req, res) => {
    const tweet = tweets.find(t => t.id === req.params.id);
    if (tweet) res.json(tweet);
    else res.status(404).json({ error: "Not found" });
});

// === 接口: 处理互动 ===
app.post('/api/tweets/:id/react', (req, res) => {
    const { type, action } = req.body;
    const tweet = tweets.find(t => t.id === req.params.id);

    if (tweet && tweet.reactions[type] !== undefined) {
        if (action === 'add') {
            tweet.reactions[type]++;
        } else if (action === 'remove') {
            // 防止减成负数
            if (tweet.reactions[type] > 0) {
                tweet.reactions[type]--;
            }
        }
        res.json(tweet);
    } else {
        res.status(404).json({ error: "Error" });
    }
});

// === 接口: 发布评论 ===
app.post('/api/tweets/:id/comment', (req, res) => {
    const { text } = req.body;
    const tweet = tweets.find(t => t.id === req.params.id);

    if (tweet) {
        const newComment = {
            id: Date.now(),
            user: userProfile.nickname,
            avatar: userProfile.avatar,
            text: text,
            timestamp: new Date().toLocaleString()
        };
        tweet.comments.unshift(newComment);
        res.json(tweet);
    } else {
        res.status(404).json({ error: "Not found" });
    }
});

const PORT = 5000;
app.listen(PORT, () => {
    console.log(`服务器运行在: http://localhost:${PORT}`);
});