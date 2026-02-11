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

// --- Multer 配置 (保持不变，支持头像和媒体) ---
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

// --- 模拟数据库 ---
let tweets = []; 
// 新增：模拟个人资料数据 (实际项目中应存入数据库)
let userProfile = {
    nickname: "新用户",
    bio: "这个人很懒，什么都没写...",
    avatar: null // 存储头像 URL
};

// --- 接口 1: 获取个人资料 ---
app.get('/api/profile', (req, res) => {
    res.json(userProfile);
});

// --- 接口 2: 更新个人资料 (支持上传头像) ---
app.post('/api/profile', upload.single('avatar'), (req, res) => {
    const { nickname, bio } = req.body;
    
    if (nickname) userProfile.nickname = nickname;
    if (bio) userProfile.bio = bio;
    
    // 如果上传了新头像，更新头像 URL
    if (req.file) {
        userProfile.avatar = `http://localhost:5000/uploads/${req.file.filename}`;
    }

    res.json(userProfile);
});

// --- 接口 3: 发布推文 (稍微修改，不再从前端传 user，而是使用当前 Profile 的昵称) ---
app.post('/api/tweets', upload.single('file'), (req, res) => {
    const { content, tags } = req.body; // 注意：去掉了 user 字段
    
    let fileType = null;
    let mediaUrl = null;

    if (req.file) {
        mediaUrl = `http://localhost:5000/uploads/${req.file.filename}`;
        const ext = path.extname(req.file.originalname).toLowerCase();
        if (['.mp4', '.webm', '.ogg', '.mov'].includes(ext)) {
            fileType = 'video';
        } else {
            fileType = 'image';
        }
    }

    const newTweet = {
        id: Date.now(),
        // 直接使用当前的个人资料信息
        user: userProfile.nickname, 
        userAvatar: userProfile.avatar, // 新增：保存发推时的头像
        content: content,
        mediaUrl: mediaUrl,
        mediaType: fileType,
        tags: tags ? tags.split(/[,，]/).map(t => t.trim()).filter(t => t) : [],
        timestamp: new Date().toLocaleString()
    };

    tweets.unshift(newTweet);
    res.status(201).json(newTweet);
});

// --- 接口 4: 获取推文列表 ---
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

const PORT = 5000;
app.listen(PORT, () => {
    console.log(`服务器运行在: http://localhost:${PORT}`);
});