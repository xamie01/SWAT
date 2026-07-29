#!/bin/bash

# G6-A9: Keep threshold changes manual and require the expectancy report as recorded justification.
set -e

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <new_threshold> <expectancy_report_justification>"
  echo "Example: $0 85 'Expectancy report 2026-07-24 shows +12% EV at threshold 85'"
  exit 1
fi

NEW_THRESHOLD=$1
JUSTIFICATION=$2

# Validate threshold is a number
if ! [[ "$NEW_THRESHOLD" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
   echo "Error: Threshold must be a number."
   exit 1
fi

if [ ${#JUSTIFICATION} -lt 15 ]; then
   echo "Error: Justification must be descriptive and reference an expectancy report (min 15 chars)."
   exit 1
fi

ENV_FILE=".env"
if [ ! -f "$ENV_FILE" ]; then
  echo "Error: .env file not found."
  exit 1
fi

# Update or insert AUTO_EXECUTE_MIN_SCORE in .env
if grep -q "^AUTO_EXECUTE_MIN_SCORE=" "$ENV_FILE"; then
  sed -i "s/^AUTO_EXECUTE_MIN_SCORE=.*/AUTO_EXECUTE_MIN_SCORE=$NEW_THRESHOLD/" "$ENV_FILE"
else
  echo "AUTO_EXECUTE_MIN_SCORE=$NEW_THRESHOLD" >> "$ENV_FILE"
fi

# Log the manual change
LOG_FILE="threshold-changes.log"
echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Threshold updated to $NEW_THRESHOLD. Justification: $JUSTIFICATION" >> "$LOG_FILE"

echo "Success! Threshold updated to $NEW_THRESHOLD."
echo "Recorded justification to $LOG_FILE."
echo "Please restart the trade-executor service to apply changes."
