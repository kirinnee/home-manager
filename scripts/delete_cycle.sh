#!/usr/bin/env bash

set -u

echo "🗑️ Normal Garbage collection..."
should_delete=$(sudo nix-collect-garbage 2>&1 | grep chmod | sed -n "s/^.*'\(\/nix\/store\/[^']*\)'.*$/\1/p" | cut -d'/' -f1-4)
[ "$should_delete" = '' ] && should_delete=$(sudo nix-collect-garbage 2>&1 | grep chmod | sed -n 's/^.*"\(\/nix\/store\/[^"]*\)".*$/\1/p' | cut -d'/' -f1-4)
echo "$should_delete"
while [ ! "$should_delete" = '' ]; do
  should_delete=$(sudo nix-collect-garbage 2>&1 | grep chmod | sed -n "s/^.*'\(\/nix\/store\/[^']*\)'.*$/\1/p" | cut -d'/' -f1-4)
  [ "$should_delete" = '' ] && should_delete=$(sudo nix-collect-garbage 2>&1 | grep chmod | sed -n 's/^.*"\(\/nix\/store\/[^"]*\)".*$/\1/p' | cut -d'/' -f1-4)
  echo "$should_delete"
  if [ ! "$should_delete" = '' ]; then
    echo "Delete ${should_delete}? (y/n)"
    read -r response
    if [ "$response" = 'y' ]; then
      sudo rm -rf "$should_delete"
    fi
  fi
done
echo "✅ Normal garbage collection completed"

echo "🗑️ Old Garbage collection..."
should_delete=$(sudo nix-collect-garbage --delete-old 2>&1 | grep chmod | sed -n "s/^.*'\(\/nix\/store\/[^']*\)'.*$/\1/p" | cut -d'/' -f1-4)
[ "$should_delete" = '' ] && should_delete=$(sudo nix-collect-garbage --delete-old 2>&1 | grep chmod | sed -n 's/^.*"\(\/nix\/store\/[^"]*\)".*$/\1/p' | cut -d'/' -f1-4)
echo "$should_delete"
while [ ! "$should_delete" = '' ]; do
  should_delete=$(sudo nix-collect-garbage --delete-old 2>&1 | grep chmod | sed -n "s/^.*'\(\/nix\/store\/[^']*\)'.*$/\1/p" | cut -d'/' -f1-4)
  [ "$should_delete" = '' ] && should_delete=$(sudo nix-collect-garbage --delete-old 2>&1 | grep chmod | sed -n 's/^.*"\(\/nix\/store\/[^"]*\)".*$/\1/p' | cut -d'/' -f1-4)
  echo "$should_delete"
  if [ ! "$should_delete" = '' ]; then
    echo "Delete ${should_delete}? (y/n)"
    read -r response
    if [ "$response" = 'y' ]; then
      sudo rm -rf "$should_delete"
    fi
  fi
done
echo "✅ Old Garbage collection completed"

echo "🗑️ -d Garbage collection..."
should_delete=$(nix-collect-garbage -d 2>&1 | grep chmod | sed -n "s/^.*'\(\/nix\/store\/[^']*\)'.*$/\1/p" | cut -d'/' -f1-4)
[ "$should_delete" = '' ] && should_delete=$(nix-collect-garbage -d 2>&1 | grep chmod | sed -n 's/^.*"\(\/nix\/store\/[^"]*\)".*$/\1/p' | cut -d'/' -f1-4)
echo "$should_delete"
while [ ! "$should_delete" = '' ]; do
  should_delete=$(nix-collect-garbage -d 2>&1 | grep chmod | sed -n "s/^.*'\(\/nix\/store\/[^']*\)'.*$/\1/p" | cut -d'/' -f1-4)
  [ "$should_delete" = '' ] && should_delete=$(nix-collect-garbage -d 2>&1 | grep chmod | sed -n 's/^.*"\(\/nix\/store\/[^"]*\)".*$/\1/p' | cut -d'/' -f1-4)
  echo "$should_delete"
  if [ ! "$should_delete" = '' ]; then
    echo "Delete ${should_delete}? (y/n)"
    read -r response
    if [ "$response" = 'y' ]; then
      sudo rm -rf "$should_delete"
    fi
  fi
done
echo "✅ -d garbage collection completed"
