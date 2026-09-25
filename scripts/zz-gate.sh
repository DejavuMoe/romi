for t in check-linux check-docs e2e smoke live-capacity; do
  if make "$t" > "/tmp/romi-$t.log" 2>&1; then echo "RESULT $t PASS"; else echo "RESULT $t FAIL"; tail -25 "/tmp/romi-$t.log"; fi
done
grep -E "^test result:" /tmp/romi-check-linux.log
grep -E "PASS: THIRD_PARTY" /tmp/romi-check-linux.log
grep -E "[0-9]+ passed|skipped" /tmp/romi-e2e.log | tail -2
grep -E "^PASS:" /tmp/romi-check-docs.log
python3 .agents/skills/prototype-first-ui/scripts/validate_workflow.py contract --project-dir designs/romi-next --phase implemented 2>&1 | tail -1
