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
        slug: 'godot',
        instance: 'programming.dev',
        feeds: [
            'godot',
        ]
    },
    {
        slug: 'unreal_engine',
        instance: 'programming.dev',
        feeds: [
            'unreal',
        ]
    },
]

// Feed data is stored in the following format: 
// joinfeeds will only include posts in common between the source feed and those in the list - It is processed first.
// exclude will remove posts from the feed based on the contents of another feed - It is processed second.
// pinCategories will pin posts in the feed that match the category name and are within the specified number of days
// content is the name of the field in the feed that contains the post content. Defaults to 'content' if not specified
// datefield is the name of the field in the feed that contains the post date. Defaults to 'pubDate' if not specified
//
// const feeds = [
//     {
//         name: 'feedname',
//         url: 'https://www.some-news-site.com/category/rss/news/',
//         content: 'description',
//         exclude: [
//             'feedname2',  // the feed contains posts from feedname2, which we don't want. So we exclude feedname2 to get feedname only.
//         ],
//         joinfeeds: [
//             'feedname3', // the feed contains posts from feedname3, which we want. So we join feedname3 to get feedname and feedname3.
//         ],
//         pinCategories: [
//             { name: 'categoryname', days: 7 }, // the feed contains posts from categoryname, which we want. So we pin categoryname posts from the feed.
//         ]
//     },
//     { 
//         name: 'feedname2',
//         url: 'https://www.some-news-site.com/category/rss/politics/',
//         content: 'content'
//     },
//     {
//         name: 'feedname3',
//         url: 'https://www.some-news-site.com/category/rss/localnews/',
//         content: 'content'
//     }
// ]

const feeds = [
    {
        name: 'godot',
        url: 'https://godotengine.org/rss.xml',
        datefield: 'pubDate',
        pinCategories: [
            { name: 'Release', days: 7 },
            { name: 'Pre-release', days: 7 },
        ],
    },
    {
        name: 'unreal',
        url: 'https://www.unrealengine.com/en-US/rss',
        content: 'summary',
        datefield: 'published',
    },
    {
        name: 'unity',
        url: 'https://blogs.unity3d.com/feed/',
        datefield: 'pubDate',
    }
]

const sleepDuration = process.env.RATE_LIMIT_MS || 2000;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

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
            timezone: 'America/Toronto',
            doTask: async ({getCommunityId, createPost}) => {
                console.log(`${chalk.green('STARTED:')} RSS Feed Fetcher.`);
                for (const feed of feeds) {
                    const rss = await parser.parseURL(feed.url);
                    
                    const cutoffDate = new Date();
                    console.log(`${chalk.white('CURRENT DATE:')} ${cutoffDate}`);
                    cutoffDate.setMonth(cutoffDate.getMonth() - 6);  // set to 6 months ago
                    console.log(`${chalk.white('CUTOFF DATE:')} ${cutoffDate}`);
                
                    let joinedItems = [];
                    // gather all items from feeds to be joined
                    if (feed.joinfeeds) {
                        console.log(`${chalk.white('FETCHING:')} joining feeds for ${feed.name}`);
                        for (const joinFeedName of feed.joinfeeds) {
                            const joinFeed = feeds.find(f => f.name === joinFeedName);

                            if (joinFeed) {
                                const joinRss = await parser.parseURL(joinFeed.url);
                                joinedItems = joinedItems.concat(joinRss.items);
                            }
                        }
                    }
                       

                    let excludeItems = [];
                    

                    // exclude feeds
                    if (feed.exclude) {
                        console.log(`${chalk.white('FETCHING:')} exclusion feeds for ${feed.name}`);
                        for (const excludeFeedName of feed.exclude) {
                            const excludeFeed = feeds.find(f => f.name === excludeFeedName);
                    
                            if (excludeFeed) {
                                const excludeRss = await parser.parseURL(excludeFeed.url);
                                for (const excludeItem of excludeRss.items) {
                                    excludeItems.push(excludeItem.link);
                                }
                            }
                        }
                    }

                    let commonItems = rss.items.filter(item => {
                        if (feed.joinfeeds && feed.exclude) {
                            return joinedItems.map(i => i.link).includes(item.link) && !excludeItems.includes(item.link);
                        } else if (feed.joinfeeds) {
                            return joinedItems.map(i => i.link).includes(item.link);
                        } else if (feed.exclude) {
                            return !excludeItems.includes(item.link);
                        } else {
                            return true;
                        }
                    });

                    for (const item of commonItems) {
                        let pin_days = 0;
                        const itemDate = new Date((feed.datefield ? item[feed.datefield] : item.pubDate).trim());
                        console.log(`${chalk.white('ITEM DATE:')} ${itemDate}`);
                        //if item is newer than 6 months old, continue
                        if (itemDate > cutoffDate) { 
                            console.log(`${chalk.green('RECENT:')} true`);
                            console.log(`${chalk.white('LINK:')} ${item.link}`);
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
                                        console.log(`${chalk.yellow('PRESENT:')} ${item.link} already present`);
                                        return;
                                    } else {
                                        return console.error(err.message);
                                    }
                                }
                                console.log(`${chalk.green('INSERTED:')} ${item.link} into database.`);

                                for (const community of communities) {
                                    if (community.feeds.includes(feed.name)) {
                                        console.log(`${chalk.green('CREATING:')} post for link ${item.link} in ${community.slug }`);
                                        const communityId = await getCommunityId({ name: community.slug, instance: community.instance });
                                        await createPost({
                                            name: item.title,
                                            body: ((feed.content && feed.content === 'summary') ? item.summary : item.content),
                                            url: item.link || undefined,
                                            community_id: communityId,
                                        });
                                        await sleep(sleepDuration);
                                        
                                    }
                                }
                                console.log(`${chalk.green('ADDED:')} ${item.link} for ${pin_days} days`);
                            });
                        }
                    
                    }
                console.log(`${chalk.green('COMPLETE:')} Feed ${feed.name} processed.`);
                }
            }
        },
        {
            cronExpression: '0 */5 * * * *',
            timezone: 'America/Toronto',
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
