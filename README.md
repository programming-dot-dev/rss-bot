# Mega Bot (Aka the megaphone bot)
A lemmy bot that watches rss feeds and posts new posts from them in communities 

This bot is made for the https://programming.dev/ communities but the source code can be modified to accomodate any community

## Setup
1. Clone the repository
2. Create an account in the instance you want the bot to have as its home (just make a regular user)
3. Create a file called .env in the bot folder and give it values in this format with the data in the quotes (dont add the slashes or the part after the slashes)
```
INSTANCE="" // The instance the bot account is in
USERNAME="" // The bot username
PASSWORD="" // The bot password
```
4. Change the data for the communities and feeds variables based on what you want set.
5. **IMPORTANT:** If you do not want to bot to back post any other posts it finds in the rss feeds, the first time you start up the bot you have to comment out the lines where it calls createPost. When you start up the bot it will insert them all into the database so it doesnt post again but as the create post is commented out it doesnt make a post. You should see a bunch of things appearing in the logs about adding new links (and it may take up to 10 minutes for the cycle to get to a time where it wants to post to start doing that). Then when its done uncomment then start the bot up again and it should behave normally
6. Open a terminal in the bot folder and run `npm install` to install dependendies and then `node main.js` to run the bot (whenever you want to start the bot again you can just do ctrl+c to interrupt the process and node main.js to start the bot)

I recommend installing something like [forever.js](https://www.npmjs.com/package/forever) for making it run continually

If you run into issues feel free to dm me on Matrix [here](https://matrix.to/#/@ategon:matrix.org)
