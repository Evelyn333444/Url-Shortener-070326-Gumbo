require("dotenv").config();

const dns = require("dns");
const express = require("express");
const mongoose = require("mongoose");
const ShortUrl = require("./models/shortUrl");

dns.setServers(["8.8.8.8", "8.8.4.4", "1.1.1.1"]);
mongoose.set("bufferCommands", false);

const app = express();
const PORT = process.env.PORT || 3001;

let lastDbError = "Connecting to MongoDB Atlas...";
let cached = global.mongoose;

if (!cached) {
  cached = global.mongoose = { conn: null, promise: null };
}

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

async function connectDatabase() {
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  if (cached.conn) {
    return cached.conn;
  }

  if (!cached.promise) {
    cached.promise = (async () => {
      const uris = getConnectionUris();
      const errors = [];
      lastDbError = "Connecting to MongoDB Atlas...";

      if (!process.env.MONGODB_URI && !process.env.MONGODB_URI_STANDARD) {
        throw new Error(
          "MONGODB_URI is not set. Add it in Vercel → Settings → Environment Variables."
        );
      }

      for (const uri of uris) {
        try {
          if (mongoose.connection.readyState !== 0) {
            await mongoose.disconnect();
          }

          console.log("Trying MongoDB connection...");
          const conn = await mongoose.connect(uri, {
            serverSelectionTimeoutMS: 15000,
            family: 4,
          });
          lastDbError = "";
          console.log("MongoDB connected");
          return conn;
        } catch (err) {
          errors.push(err.message);
          lastDbError = err.message;
          console.error("MongoDB connection error:", err.message);
        }
      }

      lastDbError =
        errors.find((message) =>
          /whitelist|IP that isn't|bad auth|Authentication failed|MONGODB_URI is not set/i.test(
            message
          )
        ) ||
        errors.find((message) => !/querySrv|ENOTFOUND/i.test(message)) ||
        errors[errors.length - 1] ||
        "Unknown connection error";

      throw new Error(lastDbError);
    })();
  }

  try {
    cached.conn = await cached.promise;
    return cached.conn;
  } catch (err) {
    cached.promise = null;
    throw err;
  }
}

app.set("view engine", "ejs");
app.use(express.urlencoded({ extended: false }));

function dbHint() {
  if (/MONGODB_URI is not set/i.test(lastDbError)) {
    return `<p><strong>Vercel fix:</strong> Go to your project on Vercel → <strong>Settings</strong> → <strong>Environment Variables</strong> → add <code>MONGODB_URI</code> with your Atlas connection string → redeploy.</p>`;
  }

  if (/Connecting to MongoDB/i.test(lastDbError)) {
    return `<p>Still connecting — wait a moment and refresh.</p>`;
  }

  if (/ENOTFOUND|querySrv/.test(lastDbError)) {
    return `<p><strong>Fix:</strong> Copy a fresh connection string from Atlas → Connect → Drivers and update <code>MONGODB_URI</code>.</p>`;
  }

  if (/whitelist|IP that isn't|Authentication failed|bad auth/i.test(lastDbError)) {
    return `<p><strong>Fix in Atlas:</strong> Network Access → <code>0.0.0.0/0</code> Active. Database Access → correct username/password in <code>MONGODB_URI</code>.</p>`;
  }

  return "";
}

async function dbReady(_req, res, next) {
  try {
    await connectDatabase();
    next();
  } catch (err) {
    lastDbError = err.message;
    return res.status(503).send(`
      <h1>Database not connected</h1>
      <p><strong>Error:</strong> ${lastDbError}</p>
      ${dbHint()}
    `);
  }
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

module.exports = app;

if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`Open http://localhost:${PORT} in your browser`);
    connectDatabase().catch((err) => {
      console.error(err.message);
    });
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
}
