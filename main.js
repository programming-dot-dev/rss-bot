import LemmyBot from "lemmy-bot";
import chalk from "chalk";
import sqlite3 from "sqlite3";
import Parser from "rss-parser";
import { load } from "js-yaml";
import "dotenv/config";
import { readFileSync } from "fs";

let {
  instances,
  feeds,
  markAsBot,
  postCheckInterval,
  dayCheckInterval,
  timezone,
  dayCutOff,
  stopPosts,
  showLogs,
  postSleepDuration,
  maxPosts,
  parserOptions,
} = load(readFileSync("config.yaml", "utf8"));

markAsBot = markAsBot ?? true;
postCheckInterval = postCheckInterval ?? 10;
dayCheckInterval = dayCheckInterval ?? 10;
timezone = timezone ?? "America/Toronto";
dayCutOff = dayCutOff ?? 7;
stopPosts = stopPosts ?? false;
showLogs = showLogs ?? false;
postSleepDuration = postSleepDuration ?? 2000;
maxPosts = maxPosts ?? 5;
parserOptions = parserOptions ?? {};

let parser = new Parser({
  customFields: {
    item: ["image"],
  },
  ...parserOptions
});
console.log(`${chalk.magenta("STARTED:")} Started Bot`);

log(
  `${chalk.grey("INSTANCES:")} ${
    Object.keys(instances).length
  } instances loaded.`
);
log(`${chalk.grey("FEEDS:")} ${Object.keys(feeds).length} feeds loaded.`);

function log(message) {
  if (showLogs) {
    console.log(message);
  }
}

// -----------------------------------------------------------------------------
// Databases

const db = new sqlite3.Database("mega.sqlite3", (err) => {
  if (err) {
    return console.error(err.message);
  }
  log(`${chalk.green("DB:")} Connected to the database.`);

  db.run(
    `CREATE TABLE IF NOT EXISTS posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        link TEXT NOT NULL UNIQUE,
        pin_days INTEGER NOT NULL DEFAULT 0,
        post_id TEXT,
        featured INTEGER DEFAULT 0
    )`,
    (err) => {
      if (err) {
        return console.error(err.message);
      }
      log(`${chalk.grey("TABLE:")} Loaded posts table.`);
    }
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS time (
        key TEXT PRIMARY KEY,
        value INTEGER
    )`,
    (err) => {
      if (err) {
        return console.error(err.message);
      }
      log(`${chalk.grey("TABLE:")} Loaded time table`);

      db.run(
        `INSERT OR IGNORE INTO time (key, value) VALUES ('day', 0)`,
        (err) => {
          if (err) {
            return console.error(err.message);
          }
        }
      );
    }
  );

  // get all posts
  db.all(`SELECT COUNT(*) as count FROM posts`, (err, rows) => {
    if (err) {
      return console.error(err.message);
    }

    log(`${chalk.grey("POSTS:")} ${rows[0].count} posts in database.`);
  });
});

// -----------------------------------------------------------------------------
// Main Bot Code

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Create the list of communities the bot will be interacting in
const allowList = [];

for (const [instance, communities] of Object.entries(instances)) {
  allowList.push({
    instance: instance,
    communities: Object.keys(communities),
  });
}

// Log in
const bot = new LemmyBot.LemmyBot({
  instance: process.env.LEMMY_INSTANCE,
  credentials: {
    username: process.env.LEMMY_USERNAME,
    password: process.env.LEMMY_PASSWORD,
  },
  dbFile: "db.sqlite3",
  federation: {
    allowList: allowList,
  },
  handlers: {
    post: {
      handle: async ({
        postView: { post, creator },
        botActions: { featurePost },
      }) => {
        // Pin post if its by the bot and set to be pinned
        if (creator.name == process.env.LEMMY_USERNAME) {
          // get link from db. If pin days > 0 then pin
          db.all(
            `SELECT * FROM posts WHERE link = ?`,
            [post.url],
            async (err, rows) => {
              if (err) {
                return console.error(err.message);
              }

              if (rows.length > 0) {
                if (rows[0].featured) {
                  // Pin post
                  await featurePost({
                    postId: post.id,
                    featureType: "Community",
                    featured: true,
                  });
                  log(
                    `${chalk.green("PINNED:")} Pinned ${post.name} in ${
                      post.community_id
                    } by ${creator.name}`
                  );

                  // Update post in db
                  db.run(
                    `UPDATE posts SET post_id = ? WHERE link = ?`,
                    [post.id, post.url],
                    (err) => {
                      if (err) {
                        return console.error(err.message);
                      }
                    }
                  );
                }
              }
            }
          );
        }
      },
    },
  },
  markAsBot: markAsBot,
  schedule: [
    {
      cronExpression: `0 */${postCheckInterval} * * * *`,
      timezone: timezone,
      doTask: async ({ botActions: { getCommunityId, createPost } }) => {
        log(`${chalk.cyan("STARTED:")} RSS Feed Fetcher.`);
        for (const [name, feed] of Object.entries(feeds)) {
          let rss;
          try {
            rss = await parser.parseURL(feed.url);
          } catch (err) {
            log(`SKIPPING: rss parse failed for ${name} with error ${err.message}`);
            continue;
          }


          const cutoffDate = new Date();
          cutoffDate.setDate(cutoffDate.getDate() - dayCutOff);

          let joinedItems = [];
          // gather all items from feeds to be joined
          if (feed.joinfeeds) {
            log(`${chalk.grey("FETCHING:")} joining feeds for ${name}`);
            for (const joinFeedName of feed.joinfeeds) {
              const joinFeed = Object.entries(feeds).find(
                (f) => f[0] === joinFeedName
              );

              if (joinFeed) {
                const joinRss = await parser.parseURL(joinFeed[1].url);
                joinedItems = joinedItems.concat(joinRss.items);
              }
            }
          }

          let excludeItems = [];
          // exclude feeds
          if (feed.exclude) {
            log(`${chalk.grey("FETCHING:")} exclusion feeds for ${name}`);
            for (const excludeFeedName of feed.exclude) {
              const excludeFeed = Object.entries(feeds).find(
                (f) => f[0] === excludeFeedName
              );

              if (excludeFeed) {
                const excludeRss = await parser.parseURL(excludeFeed[1].url);
                for (const excludeItem of excludeRss.items) {
                  excludeItems.push(excludeItem.link);
                }
              }
            }
          }

          let commonItems = rss.items.filter((item) => {
            if (feed.joinfeeds && feed.exclude) {
              return (
                joinedItems.map((i) => i.link).includes(item.link) &&
                !excludeItems.includes(item.link)
              );
            } else if (feed.joinfeeds) {
              return joinedItems.map((i) => i.link).includes(item.link);
            } else if (feed.exclude) {
              return !excludeItems.includes(item.link);
            } else {
              return true;
            }
          });

          let donePosts = 0;

          for (const item of commonItems) {
            let pin_days = 0;
            const itemDate = new Date(
              (feed.datefield ? item[feed.datefield] : item.pubDate).trim()
            );
            //if item is newer than cutoff continue
            if (itemDate > cutoffDate) {
              // if has categories then see if it's a pin
              if (feed.pinCategories && item.categories) {
                for (const category of item.categories) {
                  const found_category = feed.pinCategories.find(
                    (c) => c.name === category
                  );
                  if (found_category) {
                    pin_days = found_category.days;
                  }
                }
              }

              db.run(
                `INSERT INTO posts (link, pin_days, featured) VALUES (?, ?, ?)`,
                [item.link, pin_days, pin_days > 0 ? 1 : 0],
                async (err) => {
                  if (err) {
                    if (err.message.includes("UNIQUE constraint failed")) {
                      // do nothing
                      return;
                    } else {
                      return console.error(err.message);
                    }
                  }
                  log(
                    `${chalk.yellow("INSERTED:")} ${item.link} into database.`
                  );

                  if (stopPosts) return;

                  for (const [instance, communities] of Object.entries(
                    instances
                  )) {
                    for (const [community, value] of Object.entries(
                      communities
                    )) {
                      if (maxPosts != 0 && donePosts >= maxPosts) {
                        log(`${chalk.green("COMPLETE:")} Max posts reached.`);
                        return;
                      }

                      if (Object.values(value).includes(name)) {
                        log(
                          `${chalk.grey("CREATING:")} post for link ${
                            item.link
                          } in ${community}`
                        );
                        const communityId = await getCommunityId({
                          name: community,
                          instance: instance,
                        });

                        let title = item.title;
                        title = parseTags(title);

                        let body =
                          feed.content && feed.content === "summary"
                            ? item.summary
                            : item.content;
                        body = parseTags(body);

                        try {
                          donePosts++;
                          await createPost({
                            name: title,
                            body: body,
                            url: item.link || undefined,
                            community_id: communityId,
                          });
                        } catch (e) {
                          console.error(e);
                        }
                        await sleep(postSleepDuration);
                      }
                    }
                  }
                }
              );
            }
          }
          log(`${chalk.green("COMPLETE:")} Feed ${name} processed.`);
        }
      },
    },
    {
      cronExpression: `0 */${dayCheckInterval} * * * *`,
      timezone: "America/Toronto",
      doTask: async ({ botActions: { featurePost } }) => {
        const now = addMinutes(new Date(), 30);
        const day = now.getDay();

        db.get(`SELECT value FROM time WHERE key = 'day'`, (err, row) => {
          if (err) {
            return console.error(err.message);
          }

          if (row.value !== day) {
            db.run(
              `UPDATE time SET value = ${day} WHERE key = 'day'`,
              (err) => {
                if (err) {
                  return console.error(err.message);
                }
              }
            );

            log(`${chalk.magenta("TIME:")} Updated day to ${day}`);
            // decrement all post times by 1
            db.run(
              `UPDATE posts SET pin_days = pin_days - 1 WHERE featured = 1`,
              (err) => {
                if (err) {
                  return console.error(err.message);
                }

                log(`${chalk.magenta("TIME:")} Decremented all post times`);

                // get all posts with 0 days left and unpin them
                db.all(
                  `SELECT * FROM posts WHERE pin_days = 0 && featured = 1`,
                  async (err, rows) => {
                    if (err) {
                      return console.error(err.message);
                    }

                    for (const row of rows) {
                      await featurePost({
                        postId: row.post_id,
                        featureType: "Community",
                        featured: false,
                      });
                      log(
                        `${chalk.green("UNFEATURED:")} Unfeatured ${
                          row.post_id
                        }`
                      );
                    }

                    // set all posts with 0 days left to unfeatured
                    db.run(
                      `UPDATE posts SET featured = 0 WHERE pin_days = 0 AND featured = 1`,
                      (err) => {
                        if (err) {
                          return console.error(err.message);
                        }

                        log(
                          `${chalk.magenta(
                            "TIME:"
                          )} Unfeatured all posts with 0 days left`
                        );
                      }
                    );
                  }
                );
              }
            );
          }
        });
      },
    },
  ],
});

let tags = {
  "<em>": "**",
  "</em>": "**",
  "<p>": "",
  "</p>": "",
  "<strong>": "**",
  "</strong>": "**",
  "<br>": "\n",
  "<br/>": "\n",
  "<br />": "\n",
  "&nbsp;": " ",
  "<ol>": "",
  "</ol>": "",
  "<li>": "- ",
  "</li>": "",
  "<ul>": "",
  "</ul>": "\n",
  "&nbsp;": " ",
};

function parseTags(input) {
  let output = input;
  for (const [key, value] of Object.entries(tags)) {
    output = output.replaceAll(key, value);
  }

  // Fix Links
  const linkRegex = /<a href="([^"]+)">([^<]+)<\/a>/g;
  let match;
  match = linkRegex.exec(output);
  while (match != null) {
    output = output.replace(match[0], `[${match[2]}](${match[1]})`);
    match = linkRegex.exec(output);
  }

  // Fix Links target black
  const linkTargetRegex = /<a href="([^"]+)" target="_blank">([^<]+)<\/a>/g;
  match = linkTargetRegex.exec(output);
  while (match != null) {
    output = output.replace(match[0], `[${match[2]}](${match[1]})`);
    match = linkTargetRegex.exec(output);
  }

  // Fix font color
  const fontRegex = /<font color="([^"]+)">([^<]+)<\/font>/g;
  match = fontRegex.exec(output);
  while (match != null) {
    output = output.replace(match[0], match[2]);
    match = fontRegex.exec(output);
  }

  return output;
}

bot.start();
