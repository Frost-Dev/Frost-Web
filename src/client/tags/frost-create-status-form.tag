<frost-create-status-form>
	<form onsubmit={ submit } onkeydown={ keydown } onkeyup={ keyup }>
		<h1>投稿する</h1>
		<textarea ref='text' placeholder='ねえ今どんな気持ち？' oninput={ input } required>{ text }</textarea>
		<span>{ textMax - getTextCount() }</span>
		<button type='submit' disabled={ !getValidTextCount() }>投稿</button>
	</form>

	<style>
		:scope {
			form {
				display: flex;
				flex-direction: column;

				h1 {
					font-size: 18px;
					margin-bottom: 1rem;
				}

				textarea {
					height: 12rem;
				}

				button {
					width: 10rem;
					align-self: flex-end;
				}

				button:disabled {
					cursor: default;
				}
			}
		}
	</style>

	<script>
		this.textMax = 256;
		this.text = '';
		this.keyBuffer = [];

		// methods

		this.getTextCount = () => this.text.length;
		this.getValidTextCount = () => this.getTextCount() != 0 && this.textMax - this.getTextCount() >= 0;
		this.getNeedSubmit = () => ((this.keyBuffer[17] || this.keyBuffer[91]) && this.keyBuffer[13]) == true; // Ctrl + Enter

		this.clear = () => {
			this.text = '';
			this.update();
		};

		this.checkShortcut = () => {
			if (this.getNeedSubmit()) {
				if (this.createStatus) {
					this.createStatus();
				}
			}
		};

		// events

		this.submit = (e) => {
			e.preventDefault();

			if (this.createStatus) {
				this.createStatus();
			}
		};

		this.input = (e) => {
			this.text = this.refs.text.value;
			this.update();
		};

		this.keydown = (e) => {
			this.keyBuffer[e.which] = true;
		};

		this.keyup = (e) => {
			this.checkShortcut();

			this.keyBuffer[e.which] = false;
		};

		const restHandler = rest => {
			if (rest.request.endpoint == '/posts/post_status') {
				if (rest.success) {
					this.clear();
				}
				else {
					alert('status creation error: ' + rest.response.message);
				}
			}
		};

		this.on('mount', () => {

			// methods

			this.createStatus = () => {
				this.webSocket.sendEvent('rest', {request: {
					method: 'post', endpoint: '/posts/post_status',
					headers: {'x-api-version': 1.0},
					body: {text: this.text}
				}});
			};

			// events

			this.webSocket.on('rest', restHandler);
		});

		this.on('unmount', () => {
			this.webSocket.off('rest', restHandler);
		});
	</script>
</frost-create-status-form>
