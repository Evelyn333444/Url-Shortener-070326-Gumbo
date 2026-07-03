require("dotenv").config();

const dns = require("dns");
const express = require("express");
const mongoose = require("mongoose");
const ShortUrl = require("./models/shortUrl");

dns.setServers(["8.8.8.8", "8.8.4.4", "1.1.1.1"]);
mongoose.set("bufferCommands", false);

const app = express();
const PORT = process.env.PORT || 3001;

function getConnectionUris() {
  const uris = [];

  if (process.env.MONGODB_URI) {
    uris.push(process.env.MONGODB_URI);
  }

  if (process.env.MONGODB_URI_STANDARD) {
    uris.push(process.env.MONGODB_URI_STANDARD);
  }

  const srvMatch = process.env.MONGODB_URI?.match(
    /^mongodb\+srv:\/\/([^@]+)@([^/?]+)(\/[^?]*)?(\?.*)?$/
  );

  if (srvMatch) {
    const [, credentials, host, rawDbPath, query = ""] = srvMatch;
    const dbPath =
      !rawDbPath || rawDbPath === "/" ? "/urlShortener" : rawDbPath;
    const params = new URLSearchParams(query.replace(/^\?/, ""));
    params.set("ssl", "true");
    params.set("authSource", "admin");
    params.set("directConnection", "true");
    if (!params.has("retryWrites")) params.set("retryWrites", "true");
    if (!params.has("w")) params.set("w", "majority");

    uris.push(
      `mongodb://${credentials}@${host}:27017${dbPath}?${params.toString()}`
    );
  }

  if (uris.length === 0) {
    uris.push("mongodb://localhost:27017/urlShortener");
  }

  return [...new Set(uris)];
}

let lastDbError = "Connecting to MongoDB Atlas...";

app.set("view engine", "ejs");
app.use(express.urlencoded({ extended: false }));

function dbReady(_req, res, next) {
  if (mongoose.connection.readyState !== 1) {
    let hint = "";

    if (/Connecting to MongoDB/i.test(lastDbError)) {
      hint = `<p>Still connecting — wait about 20 seconds and refresh. If this stays, check the terminal for errors.</p>`;
    } else if (/ENOTFOUND|querySrv/.test(lastDbError)) {
      hint = `<p><strong>Most likely fix:</strong> The cluster name in <code>.env</code> is wrong or the cluster was deleted. In Atlas, open <strong>Database</strong> → your cluster → <strong>Connect</strong> → <strong>Drivers</strong>, copy the full connection string, and replace <code>MONGODB_URI</code>. The part after <code>@</code> must be your real cluster, like <code>mycluster.abc123.mongodb.net</code> — not <code>cluster.mongodb.net</code> or an old deleted name.</p>`;
    } else if (/whitelist|IP that isn't|Authentication failed|bad auth/i.test(lastDbError)) {
      hint = `<p><strong>Check these in Atlas (same project as UrlShortener07032026):</strong></p>
      <ol>
        <li><strong>Network Access</strong> (not the cluster page) → entry <code>0.0.0.0/0</code> must say <strong>Active</strong></li>
        <li><strong>Database Access</strong> → user <code>brackesb12_db_user</code> exists and password matches <code>.env</code></li>
        <li><strong>Database</strong> → cluster is running (green), not paused</li>
      </ol>`;
    }

    return res.status(503).send(`
      <h1>Database not connected</h1>
      <p><strong>Error:</strong> ${lastDbError}</p>
      ${hint}
      <p>Restart nodemon after updating <code>.env</code>, then refresh.</p>
    `);
  }
  next();
}

app.get("/", dbReady, async (req, res) => {
  const shortUrls = await ShortUrl.find();
  res.render("index", { shortUrls });
});

app.post("/shortUrls", dbReady, async (req, res) => {
  await ShortUrl.create({ full: req.body.fullUrl });
  res.redirect("/");
});

app.get("/:short", dbReady, async (req, res) => {
  const shortUrl = await ShortUrl.findOne({ short: req.params.short });

  if (shortUrl == null) {
    return res.sendStatus(404);
  }

  shortUrl.clicks++;
  await shortUrl.save();
  res.redirect(shortUrl.full);
});

async function connectDatabase() {
  const uris = getConnectionUris();
  const errors = [];

  lastDbError = "Connecting to MongoDB Atlas...";

  for (const uri of uris) {
    try {
      if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
      }

      console.log("Trying MongoDB connection...");

      await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 15000,
        family: 4,
      });
      lastDbError = "";
      console.log("MongoDB connected");
      return;
    } catch (err) {
      errors.push(err.message);
      lastDbError = err.message;
      console.error("MongoDB connection error:", err.message);
    }
  }

  lastDbError =
    errors.find((message) => /whitelist|IP that isn't|bad auth|Authentication failed/i.test(message)) ||
    errors.find((message) => !/querySrv|ENOTFOUND/i.test(message)) ||
    errors[errors.length - 1] ||
    "Unknown connection error";

  console.error("Retrying MongoDB connection in 5 seconds...");
  const host = process.env.MONGODB_URI?.match(/@([^/?]+)/)?.[1];
  if (host) {
    console.error(`Trying host: ${host}`);
  }
  setTimeout(connectDatabase, 5000);
}

const server = app.listen(PORT, () => {
  console.log(`Open http://localhost:${PORT} in your browser`);
  connectDatabase();
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `Port ${PORT} is in use. Stop the other process or run: PORT=3002 npm run devStart`
    );
  } else {
    console.error(err);
  }
  process.exit(1);
});
