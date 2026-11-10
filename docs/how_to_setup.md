If these instructions are outdated, please raise an issue or send us a Pull Request.

# How to Setup

You need these to use Mail:

- A domain name
- A server to run Mail

If you want to send emails using Mail. You need a 3rd party email sending service.(Currently we're using [Mailgun](https://mailgun.com))

For detailed instruction, please keep reading this document.

## 1. Install Mail

1. Clone this git repository
   ```
   git clone https://github.com/hoiekim/mail.git
   ```
2. Copy `.env.example` file and name it `.env.local` then determine environment variables in `.env.local` file as following.

   ```
   EMAIL_DOMAIN             // Domain name to use when sending & receiving mails.
   APP_HOSTNAME             // Domain name that hosts the web app.

   SECRET                   // Private value that signs session cookies. Required when
                            // NODE_ENV=production: the server refuses to boot when it is
                            // unset or set to a value this repository publishes, because
                            // either one lets anyone forge a signed cookie. Generate one
                            // with `openssl rand -base64 32`.
   ADMIN_PASSWORD           // Password the admin user is created with, on first run.

   ADMIN_PASSWORD_RESET     // (optional) Set to 1 for one boot to reset admin's password
                            // to ADMIN_PASSWORD. Remove it afterwards.

   MAILGUN_KEY              // (optional) API key issued by Mailgun. Used to send emails.

   OPENAI_KEY               // (optional) API key issued by OpenAI. Used to get insight of emails.

   PUSH_VAPID_PUBLIC_KEY    // (optional) API key issued by Push. Used to send push notifications.
   PUSH_VAPID_PRIVATE_KEY   // (optional) API key issued by Push. Used to send push notifications.

   SSL_CERTIFICATE=         // (optional) SSL certificate file path. Used for TLS in IMAP server.
   SSL_CERTIFICATE_KEY=     // (optional) SSL certificate key file path. Used for TLS in IMAP server.
   ```

## 2. Setup DNS Records

Make sure your domain's MX record points to the server you're running Mail. In order to setup your MX record, check your DNS settings in your domain's provider.

- Exmaple (assuming your domain name is `domain.com` and your server ip is `0.0.0.0`):
  |Type|Name|Key|Meaning|
  |----|----|---|-------|
  |A|mail|0.0.0.0|It points request for `mail.domain.com` to `0.0.0.0`|
  |MX|@|mail.domain.com|It points emails sent to `*@domain.com` and `*@*.domain.com` to `mail.domain.com`|

In the example above, `A` record is pointing `mail.domain.com` to `0.0.0.0` and `MX` record is pointing emails to `mail.domain.com`. When some email is sent to `something@domain.com`, it will look up `domain.com`'s `MX` record and send the email data to where it points to. So it will be eventually delivered to `0.0.0.0`

## 3. Setup Mailgun

1. Go to [Mailgun](https://mailgun.com) and follow instructions to get started.
2. Get the API key and paste it in `.env.local` file.

If you want to use this app only for receiving mails, skip this step.

## 4. Run app

1. Production mode

   Make sure you have docker and docker-compose installed in your machine.

   ```
   docker-compose up
   ```

2. Development mode

   Set following values in `.env.local` file to configure PostgreSQL for development. You can install and run PostgreSQL locally or use the docker-compose setup.

   ```
   POSTGRES_HOST=localhost  // PostgreSQL host address
   POSTGRES_PORT=5432       // PostgreSQL port
   POSTGRES_USER=postgres   // PostgreSQL username
   POSTGRES_PASSWORD=inbox  // PostgreSQL password
   POSTGRES_DATABASE=mail   // PostgreSQL database name
   ```

   Then run app using this command

   ```
   bun install
   bun run dev
   ```

### Running behind a reverse proxy

In production the app resolves each request's client address through Express's
`trust proxy` setting, which is fixed to the loopback and private ranges. A
forwarding header is honoured only when the connection itself arrives from one
of those addresses — in other words, from the proxy. A request that reaches the
app port from anywhere else is attributed to its own socket address and its
forwarding headers are ignored.

Rate limits are keyed on that address, so the proxy has to pass the real client
address along or every client ends up sharing one bucket. With nginx:

```
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Forwarded-Proto $scheme;
```

`X-Forwarded-Proto` is what lets the session cookie's `Secure` attribute apply;
without it Express sees a plaintext request and declines to set the cookie.
`X-Real-IP` is not read — set `X-Forwarded-For` even if you already set it.

Nothing other than the proxy needs to reach the app's HTTP port, so there is no
reason to publish it on a public interface.

### Mail ports behind a TCP proxy

The SMTP and IMAP ports can sit behind a TCP proxy too, such as nginx's
`stream` module, so that two copies of the server can run side by side while
one replaces the other. Set `PROXY_PROTOCOL=true`, and have the proxy open
every connection with a PROXY protocol v1 header:

```
stream {
  server {
    listen 25;
    proxy_pass mail:25;
    proxy_protocol on;
  }
  # ...one server per mail port. Set proxy_timeout above 35 minutes, or the
  # proxy cuts IMAP IDLE connections (nginx's default is 10 minutes).
}
```

The header is accepted only from the same loopback and private ranges as the
HTTP forwarding headers. That doesn't stop anything else on those ranges from
sending one: another container on the network, or a client reaching a port
that is still published through Docker's port forwarding, can then name any
client address. With the setting on, only the proxy should reach the mail
ports. TLS is unaffected: the proxy passes it through, and the server
terminates it as before.

### Environment Variables

This app in default uses `.env` and `.env.local` to load environment variables. `.env` is included in the repository, intending to determine consistent variables that are related to React's build process, etc. `.env.local` is not included in the repository, intending to determine variables that differ by the app's host environment, external API credentials, etc. Additionally, we have an option to add another one as `.env.<NODE_ENV>` where you can set `NODE_ENV` in your terminal for example in Mac/Linux, `NODE_ENV=development` or in Windows cmd, `set NODE_ENV=development`.

## 5. Enjoy!

Default port number is 3004. So you can connect to Mail at http://(your-server-ip):3004

For development mode, use port number 3000 instead.

Admin username is `admin`. On the first run its password is the value of the environment variable called `ADMIN_PASSWORD`. After that, the password stored in the database wins — changing `ADMIN_PASSWORD` and restarting does not overwrite a password you changed in the app. To reset a password you have lost, boot once with `ADMIN_PASSWORD_RESET=1` and then remove that variable.
