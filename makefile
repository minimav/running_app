.PHONY: blog

build:
	echo "Building Docker image running-app, "
	docker build -t running-app .

clean:
	docker system prune

run-local-dev:
	RUNNING_APP_MODE=DEV python src/main.py

run-local:
	RUNNING_APP_MODE=PROD python src/main.py

start: build
	echo "Running container based on image running-app in PROD mode"
	docker run -p 1234:1234 -e RUNNING_APP_MODE=PROD running-app

freeze:
	pip list --format=freeze > requirements.txt

blog:
	cd blog; bundle exec jekyll serve --trace
