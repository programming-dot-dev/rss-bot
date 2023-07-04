import LemmyBot from 'lemmy-bot';
import chalk from 'chalk';
import sqlite3 from 'sqlite3';
import Parser from 'rss-parser';
import 'dotenv/config';

let parser = new Parser({
    customFields: {
      item: ['image'],
    }
});
console.log(`${chalk.magenta('STARTED:')} Started Bot`)

// -----------------------------------------------------------------------------
// Databases

const db = new sqlite3.Database('mega.sqlite3', (err) => {
    if (err) {
        return console.error(err.message);
    }
    console.log('Connected to the database.');

    db.run(`CREATE TABLE IF NOT EXISTS posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        link TEXT NOT NULL UNIQUE,
        pin_days INTEGER NOT NULL DEFAULT 0,
        message_id INTEGER,
        featured INTEGER DEFAULT 0
    )`, (err) => {
        if (err) {
            return console.error(err.message);
        }
        console.log('Loaded posts table.');
    });

    db.run(`CREATE TABLE IF NOT EXISTS time (
        key TEXT PRIMARY KEY,
        value INTEGER
    )`, (err) => {
        if (err) {
            return console.error(err.message);
        }
        console.log('Loaded time table');

        db.run(`INSERT OR IGNORE INTO time (key, value) VALUES ('day', 0)`, (err) => {
            if (err) {
                return console.error(err.message);
            }
        });
    });

        // get all posts
    db.all(`SELECT COUNT(*) as count FROM posts`, (err, rows) => {
        if (err) {
            return console.error(err.message);
        }

        console.log(`${chalk.magenta('POSTS:')} ${rows[0].count} posts in database.`)
    });
});

// -----------------------------------------------------------------------------
// Data

const communities = [
    {
        slug: 'localnews',
        instance: 'tucson.social',
        feeds: [
            'localnews',
        ],
        exclude: [
            'localpolitics',
        ]
    },
    {
        slug: 'tucsonpolitics',
        instance: 'tucson.social',
        feeds: [
            'localpolitics',
        ]
    },
]

const feeds = [
    {
        name: 'localnews',
        url: 'https://www.tucsonsentinel.com/local/rss/',
        content: 'description',
    },
    {
        name: 'localpolitics',
        url: 'https://www.tucsonsentinel.com/category/rss/politics/',
        content: 'description',
    }
]

const exclude = [
    {
        name: 'localpolitics',
        url: 'https://www.tucsonsentinel.com/category/rss/politics/',
        content: 'description',
    }
]

// -----------------------------------------------------------------------------
// Main Bot Code

// Create the list of communities the bot will be interacting in
const allowList = []

for (const community of communities) {
    const allowListEntry = allowList.find((item) => item.instance == community.instance)

    if (allowListEntry) {
        allowListEntry.communities.push(community.slug)
    }
    else {
        allowList.push({
            instance: community.instance,
            communities: [community.slug]
        })
    }
}


const bot = new LemmyBot.LemmyBot({
    instance: process.env.INSTANCE,
    credentials: {
        username: process.env.USERNAME,
        password: process.env.PASSWORD,
    },
    dbFile: 'db.sqlite3',
    federation: {
        allowList: allowList,
    },
    handlers: {
        post: {
            handle: async ({
                postView: {
                    post,
                    creator
                },
                botActions: { featurePost },
            }) => {
                // Pin post if its by the bot and set to be pinned
                if (creator.name == process.env.USERNAME) {
                    // get link from db. If pin days > 0 then pin
                    db.all(`SELECT * FROM posts WHERE link = ?`, [post.url], async (err, rows) => {
                        if (err) {
                            return console.error(err.message);
                        }

                        if (rows.length > 0) {
                            if (rows[0].featured) {
                                // Pin post
                                await featurePost({postId: post.id, featureType: "Community", featured: true})
                                console.log(`${chalk.green('PINNED:')} Pinned ${post.name} in ${post.community_id} by ${creator.name}`)
                            }
                        }
                    });
                }
            }
        }
    },
    schedule: [
        {
            cronExpression: '0 */10 * * * *',
            timezone: 'America/Phoenix',
            runAtStart: true,
            doTask: async ({getCommunityId, createPost}) => {
                console.log(`${chalk.green('STARTED:')} RSS Feed Fetcher.`);
                for (const feed of feeds) {
                    const rss = await parser.parseURL(feed.url);
                    const cutoffDate = new Date();
                    console.log(`${chalk.green('CURRENT DATE:')} ${cutoffDate}`);
                    cutoffDate.setMonth(cutoffDate.getMonth() - 6);  // set to 6 months ago
                    console.log(`${chalk.green('CUTOFF DATE:')} ${cutoffDate}`);

                    for (const item of rss.items) {
                        let pin_days = 0;
                        const itemDate = new Date(item['dc:date'].trim());
                        console.log(`${chalk.green('ITEM DATE:')} ${itemDate}`);

                        //if item is newer than 6 months old, continue
                        if (itemDate > cutoffDate) { 
                            console.log(`${chalk.green('RECENT:')} true`);
                            console.log(`${chalk.green('LINK:')} ${item.link}`);
                            // if has categories then see if it's a pin
                            if (feed.pinCategories && item.categories) {
                                for (const category of item.categories) {
                                    const found_category = feed.pinCategories.find(c => c.name === category);
                                    if (found_category) {
                                        pin_days = found_category.days;
                                    }
                                }
                            }

                            db.run(`INSERT INTO posts (link, pin_days, featured) VALUES (?, ?, ?)`, [item.link, pin_days, pin_days > 0 ? 1 : 0], async (err) => {
                                if (err) {
                                    if (err.message.includes('UNIQUE constraint failed')) {
                                        // do nothing
                                        console.log(`${chalk.green('PRESENT:')} ${item.link} already present`);
                                        return;
                                    } else {
                                        return console.error(err.message);
                                    }
                                }
                                console.log(`${chalk.green('INSERTED:')} ${item.link} into database.`);

                                for (const community of communities) {
                                    if (community.feeds.includes(feed.name)) {
                                        let excludeItems = [];

                                        // If 'exclude' exists for the current community, parse its feeds and collect their items
                                        if (community.exclude) {
                                            console.log(`${chalk.green('FETCHING:')} exclude feeds for ${community.slug}`);
                                            for (const excludeFeed of community.exclude) {
                                                const excludeRss = await parser.parseURL(excludeFeed);
                                                for (const excludeItem of excludeRss.items) {
                                                    excludeItems.push(excludeItem.link);
                                                }
                                            }
                                        }

                                        // Process the item only if its link is not in the excludeItems list
                                        if (!excludeItems.includes(item.link)) {
                                            console.log(`${chalk.green('CREATING:')} post for link ${item.link} in ${community.slug }`);
                                            const communityId = await getCommunityId({ name: community.slug, instance: community.instance });
                                            await createPost({
                                                name: item.title,
                                                body: ((feed.content && feed.content === 'summary') ? item.summary : item.content),
                                                url: item.link || undefined,
                                                community_id: communityId,
                                            });
                                        }
                                    }
                                }
                                console.log(`${chalk.green('ADDED:')} ${item.link} for ${pin_days} days`);
                            });
                        }
                    }
                }
            }
        },
        {
            cronExpression: '0 */5 * * * *',
            timezone: 'America/Phoenix',
            doTask: async ({ featurePost }) => {
                const now = addMinutes(new Date(), 30);
                const day = now.getDay();

                db.get(`SELECT value FROM time WHERE key = 'day'`, (err, row) => {
                    if (err) {
                        return console.error(err.message);
                    }

                    if (row.value !== day) {
                        db.run(`UPDATE time SET value = ${day} WHERE key = 'day'`, (err) => {
                            if (err) {
                                return console.error(err.message);
                            }
                        });

                        console.log(`${chalk.magenta('TIME:')} Updated day to ${day}`);
                        // decrement all post times by 1
                        db.run(`UPDATE posts SET pin_days = pin_days - 1 WHERE featured = 1`, (err) => {
                            if (err) {
                                return console.error(err.message);
                            }

                            console.log(`${chalk.magenta('TIME:')} Decremented all post times`);

                            // get all posts with 0 days left and unpin them
                            db.all(`SELECT * FROM posts WHERE pin_days = 0 && featured = 1`, async (err, rows) => {
                                if (err) {
                                    return console.error(err.message);
                                }

                                for (const row of rows) {
                                    await featurePost({postId: row.post_id, featureType: "Community", featured: false})
                                    console.log(`${chalk.green('UNFEATURED:')} Unfeatured ${row.post_id} in ${row.community_id}`);
                                }

                                // set all posts with 0 days left to unfeatured
                                db.run(`UPDATE posts SET featured = 0 WHERE pin_days = 0 AND featured = 1`, (err) => {
                                    if (err) {
                                        return console.error(err.message);
                                    }

                                    console.log(`${chalk.magenta('TIME:')} Unfeatured all posts with 0 days left`);
                                });
                            });
                        });
                    }
                });
            }
        }
    ]
});

bot.start();
