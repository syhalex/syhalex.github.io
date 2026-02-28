const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

const dbPath = './database.sqlite';
const uploadsDir = './uploads';
const guideDirName = 'guide';

async function resetData() {
    console.log('--- 开始清理用户数据 ---');

    const db = new sqlite3.Database(dbPath);

    const tablesToClear = ['bookmarks', 'comments', 'tweets', 'users'];

    db.serialize(() => {
        // 1. 清理数据库
        tablesToClear.forEach(table => {
            db.run(`DELETE FROM ${table}`, (err) => {
                if (err) {
                    console.error(`清理表 ${table} 失败:`, err.message);
                } else {
                    console.log(`已清空表: ${table}`);
                }
            });
        });

        // 验证引导配置是否还在
        db.get(`SELECT COUNT(*) as count FROM site_config WHERE key = 'beginner_guide'`, (err, row) => {
            if (err) {
                console.error('验证引导配置失败:', err.message);
            } else {
                console.log(`引导配置状态: ${row.count > 0 ? '已保留 (存在)' : '未发现 (可能本来就没有)'}`);
            }
        });
    });

    // 2. 清理文件系统 (保留 uploads/guide)
    if (fs.existsSync(uploadsDir)) {
        const items = fs.readdirSync(uploadsDir);
        items.forEach(item => {
            const itemPath = path.join(uploadsDir, item);
            if (item === guideDirName) {
                console.log(`[保留] 引导图片目录: ${itemPath}`);
            } else {
                try {
                    fs.rmSync(itemPath, { recursive: true, force: true });
                    console.log(`[已删除] 用户上传内容: ${itemPath}`);
                } catch (err) {
                    console.error(`删除 ${itemPath} 失败:`, err.message);
                }
            }
        });
    }

    db.close((err) => {
        if (err) {
            console.error('关闭数据库失败:', err.message);
        } else {
            console.log('--- 清理完成 ---');
            console.log('请重启 server.js 以确保状态同步。');
        }
    });
}

resetData();
