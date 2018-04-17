const bodyParser = require('body-parser');
const checkLogin = require('./helpers/check-login');
const compression = require('compression');
const connectRedis = require('connect-redis');
const createSession = require('./helpers/create-session');
const csurf = require('csurf');
const express = require('express');
const expressSession = require('express-session');
const helmet = require('helmet');
const HttpServerError = require('./helpers/http-server-error');
const isSmartPhone = require('./helpers/is-smart-phone');
const path = require('path');
const request = require('request-promise');
const StreamingRest = require('./helpers/streaming-rest');

/**
 * クライアントサイドにWebページと各種操作を提供します
 */
module.exports = async (hostApiConnection, debug, config) => {
	const streamingRest = new StreamingRest(hostApiConnection);

	const app = express();
	const sessionStore = new (connectRedis(expressSession))({});

	// == app settings ==

	app.set('views', path.join(__dirname, 'views'));
	app.set('view engine', 'pug');

	// == Middlewares ==

	// body parser

	app.use(bodyParser.urlencoded({ extended: false }));
	app.use(bodyParser.json());

	// compression

	app.use(compression({
		threshold: 0,
		level: 9,
		memLevel: 9
	}));

	// session

	app.use(expressSession({
		store: sessionStore,
		name: config.web.session.name,
		secret: config.web.session.SecretToken,
		cookie: {
			httpOnly: false,
			maxAge: 7 * 24 * 60 * 60 * 1000 // 7days
		},
		resave: true,
		saveUninitialized: true,
		rolling: true
	}));

	// securities

	app.use(helmet({ frameguard: { action: 'deny' } }));
	app.use(csurf());

	// page middleware

	app.use((req, res, next) => {
		try {
			req.isSmartPhone = isSmartPhone(req.header('User-Agent'));

			res.renderPage = (pageParams, renderParams) => {
				pageParams = Object.assign(pageParams || {}, {
					csrf: req.csrfToken(),
					isSmartPhone: req.isSmartPhone,
					siteKey: config.web.reCAPTCHA.siteKey
				});

				// memo: クライアントサイドでは、パラメータ中にuserIdが存在するかどうかでWebSocketへの接続が必要かどうかを判断します。このコードはそのために必要です。
				const accessToken = req.session.accessToken;
				if (accessToken != null) {
					pageParams.userId = accessToken.split('-')[0];
				}

				let pageRenderParams = {
					scriptFile: '/bundle.js',
					params: pageParams
				};
				pageRenderParams = Object.assign(pageRenderParams, renderParams);

				res.render('page', pageRenderParams);
			};

			next();
		}
		catch (err) {
			throw new HttpServerError(500, err.message, true);
		}
	});

	// static files

	app.use(express.static(path.join(__dirname, '../client'), { etag: false }));

	// == routings ==

	app.route('/session')
		.put(async (req, res, next) => {
			try {
				if (req.session.accessToken == null) {
					await createSession(req, streamingRest, config);
				}

				res.json({ message: 'ok', token: req.session.clientSideAccessToken });
			}
			catch(err) {
				if (err instanceof HttpServerError) {
					err.isJson = true;
					next(err);
				}
				else {
					next(new HttpServerError(500, err.message, true));
				}
			}
		})
		.delete(checkLogin, (req, res) => {
			try {
				if (req.session.accessToken != null) {
					req.session.accessToken = null;
					req.session.clientSideAccessToken = null;
				}
				res.json({ message: 'ok', token: null });
			}
			catch (err) {
				if (err instanceof HttpServerError) {
					err.isJson = true;
					throw err;
				}
				else {
					throw new HttpServerError(500, err.message, true);
				}
			}
		});

	app.route('/session/register')
		.post(async (req, res, next) => {
			try {
				// recaptcha
				let recaptchaResult;
				try {
					recaptchaResult = await request('https://www.google.com/recaptcha/api/siteverify', {
						method: 'POST',
						json: true,
						form: {
							secret: config.web.reCAPTCHA.secretKey,
							response: req.body.recaptchaToken
						}
					});
				}
				catch (err) {
					throw new HttpServerError(500, `recaptcha verification error: ${err.message}`, true);
				}
				if (recaptchaResult.success !== true) {
					throw new HttpServerError(400, `recaptcha verification error: ${JSON.stringify(recaptchaResult['error-codes'])}`, true);
				}

				// creation user
				const creationResult = await streamingRest.request('post', '/users', { body: req.body });
				if (!creationResult.response.user) {
					throw new HttpServerError(creationResult.statusCode || 500, `session register error: ${creationResult.response.message}`, true);
				}

				// creation session
				await createSession(req, streamingRest, config);

				res.json({ message: 'ok', token: req.session.clientSideAccessToken });
			}
			catch (err) {
				if (err instanceof HttpServerError) {
					err.isJson = true;
					next(err);
				}
				else {
					next(new HttpServerError(500, err.message, true));
				}
			}
		});

	app.post('/auth', (req, res) => {

	});

	// pages

	const pages = [
		'/',
		'/general',
		'/users/:screenName',
		'/userlist',
		'/posts/:postId',
		'/dev',
		'/auth'
	];

	for (const page of pages) {
		app.get(page, (req, res) => res.renderPage());
	}

	// page not found
	app.use(() => { throw new HttpServerError(404, 'page not found'); });

	// csrf token
	app.use((err, req, res, next) => {
		if (err.code !== 'EBADCSRFTOKEN') return next(err);
		res.status(400).json({ error: { message: err.message } });
	});

	// HttpServerError
	app.use((err, req, res, next) => {
		if (!(err instanceof HttpServerError)) return next(err);
		res.status(err.status);
		if (err.isJson) {
			res.json({ error: { message: err.message } });
		}
		else {
			res.renderPage({ error: err.message, code: err.status });
		}
	});

	// others
	app.use((err, req, res, next) => {
		// console.log('[http server] error:', err.message);
		res.status(500).renderPage({ error: err.message, code: 500 });
	});

	// == listening start ==

	const listen = (port) => new Promise((resolve, reject) => {
		if (port == null) reject(new ReferenceError('port is null reference'));
		if (typeof port != 'number') reject(new TypeError('port is not a number'));

		const http = app.listen(port, () => {
			console.log('[http server]', 'listening on port:', port);
			resolve(http);
		});
	});
	const http = await listen(config.web.port);

	console.log('[http server]', 'initialized');

	return {
		http: http,
		sessionStore: sessionStore
	};
};
