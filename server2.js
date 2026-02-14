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
app.post('/api/tweets', upload.single('file'), (req, res) => {
    const { content, tags } = req.body;
    
    let fileType = null;
    let mediaUrl = null;

    if (req.file) {
        mediaUrl = `http://localhost:5000/uploads/${req.file.filename}`;
        const ext = path.extname(req.file.originalname).toLowerCase();
        fileType = ['.mp4', '.webm', '.ogg', '.mov'].includes(ext) ? 'video' : 'image';
    }

    const newTweet = {
        id: Date.now().toString(), // 转为字符串方便比较
        user: userProfile.nickname, 
        userAvatar: userProfile.avatar,
        content: content,
        mediaUrl: mediaUrl,
        mediaType: fileType,
        tags: tags ? tags.split(/[,，]/).map(t => t.trim()).filter(t => t) : [],
        timestamp: new Date().toLocaleString(),
        // === 新增字段 ===
        reactions: {
            like: 0,
            confused: 0,
            god: 0
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

// === 新增接口: 获取单条推文详情 ===
app.get('/api/tweets/:id', (req, res) => {
    const tweet = tweets.find(t => t.id === req.params.id);
    if (tweet) res.json(tweet);
    else res.status(404).json({ error: "Not found" });
});

// === 新增接口: 处理互动 (点赞/问号/神) ===
app.post('/api/tweets/:id/react', (req, res) => {
    const { type } = req.body; // type: 'like', 'confused', 'god'
    const tweet = tweets.find(t => t.id === req.params.id);
    
    if (tweet && tweet.reactions[type] !== undefined) {
        tweet.reactions[type]++; // 简单增加计数，不验证用户是否重复点击
        res.json(tweet);
    } else {
        res.status(404).json({ error: "Error" });
    }
});

// === 新增接口: 发布评论 ===
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
        tweet.comments.push(newComment);
        res.json(tweet);
    } else {
        res.status(404).json({ error: "Not found" });
    }
});

const PORT = 5000;
app.listen(PORT, () => {
    console.log(`服务器运行在: http://localhost:${PORT}`);
});