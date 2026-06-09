#!/bin/bash
set -euo pipefail

RUN_PHPSTAN=false
RUN_PHP_LINT=false
RUN_SHELLCHECK=false

if [[ $# -eq 0 ]]; then
  RUN_PHPSTAN=true
  RUN_PHP_LINT=true
  RUN_SHELLCHECK=true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    -phpstan|--phpstan)
      RUN_PHPSTAN=true; shift;;
    -phplint|--phplint)
      RUN_PHP_LINT=true; shift;;
    -shellcheck|--shellcheck)
      RUN_SHELLCHECK=true; shift;;
    -h|--help)
      echo "Usage: $0 [-phpstan] [-phplint] [-shellcheck]"; exit 0;;
    *)
      echo "Unknown option: $1"; exit 1;;
  esac
done

if [[ "$RUN_PHPSTAN" == true ]]; then
  if [[ -f vendor/bin/phpstan ]]; then
    echo "Running PHPStan static analysis..."
    php vendor/bin/phpstan analyse --memory-limit=512M
    echo "PHPStan static analysis passed."
  else
    echo "PHPStan not found. Skipping static analysis."
  fi
fi

if [[ "$RUN_PHP_LINT" == true ]]; then
  echo "Running PHP syntax checks..."
  php -l source/docker.networks/include/Exec.php
  php -l source/docker.networks/include/ExecFunctions.php
  echo "PHP syntax checks passed."
fi

if [[ "$RUN_SHELLCHECK" == true ]]; then
  if command -v shellcheck >/dev/null; then
    echo "Running ShellCheck..."
    shellcheck build.sh deploy.sh install.sh test.sh build_in_docker.sh source/pkg_build.sh
    echo "ShellCheck passed."
  else
    echo "ShellCheck not found. Skipping shell script lint."
  fi
fi
