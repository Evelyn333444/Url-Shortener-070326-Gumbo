require("dotenv").config();

const dns = require("dns");
const express = require("express");
const mongoose = require("mongoose");
const ShortUrl = require("./models/shortUrl");

dns.setServers(["8.8.8.8", "8.8.4.4", "1.1.1.1"]);

const app = express();
const PORT = process.env.PORT || 3001;

function getConnectionUris() {
  const uris = [];

  if (process.env.MONGODB_URI_STANDARD) {
    uris.push(process.env.MONGODB_URI_STANDARD);
  }

  if (process.env.MONGODB_URI?.startsWith("mongodb://")) {
    uris.push(process.env.MONGODB_URI);
  }

  const srvMatch = process.env.MONGODB_URI?.match(
    /^mongodb\+srv:\/\/([^@]+)@([^/?]+)(\/[^?]*)?(\?.*)?$/
  );

  if (srvMatch) {
    const [, credentials, host, dbPath = "/urlShortener", query = ""] = srvMatch;
    const params = new URLSearchParams(query.replace(/^\?/, ""));
    params.set("ssl", "true");
    params.set("authSource", "admin");
    if (!params.has("retryWrites")) params.set("retryWrites", "true");
    if (!params.has("w")) params.set("w", "majority");

    // Use direct TLS connection only. Avoid mongodb+srv SRV lookups entirely.
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
    } else     if (/ENOTFOUND|querySrv/.test(lastDbError)) {
      hint = `<p><strong>Most likely fix:</strong> The cluster name in <code>.env</code> is wrong or the cluster was deleted. In Atlas, open <strong>Database</strong> → your cluster → <strong>Connect</strong> → <strong>Drivers</strong>, copy the full connection string, and replace <code>MONGODB_URI</code>. The part after <code>@</code> must be your real cluster, like <code>mycluster.abc123.mongodb.net</code> — not <code>cluster.mongodb.net</code> or an old deleted name.</p>`;
    } else if (/whitelist|IP that isn't/i.test(lastDbError)) {
      hint = `<p><strong>Most likely fix:</strong> In Atlas, go to <strong>Network Access</strong> and allow your IP or <code>0.0.0.0/0</code>.</p>`;
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

app.get("/:short", async (req, res) => {
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

      await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 10000,
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
