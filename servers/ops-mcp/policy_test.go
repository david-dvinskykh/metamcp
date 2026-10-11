package main

import "testing"

func TestCheckReadOnly(t *testing.T) {
	allowed := []string{
		"tail -n 200 /var/log/asterisk/full",
		"grep -i error /var/log/asterisk/full | tail -50",
		`asterisk -rx "pjsip show endpoints"`,
		`asterisk -rx "core show channels"`,
		`mysql -e "SELECT calldate, src, dst FROM asteriskcdrdb.cdr ORDER BY calldate DESC LIMIT 5"`,
		"systemctl status asterisk",
		"docker compose ps",
		"df -h",
		"fwconsole ma list",
	}
	for _, c := range allowed {
		if err := checkReadOnly(c); err != nil {
			t.Errorf("%q should be allowed: %v", c, err)
		}
	}
	refused := []string{
		"rm -rf /tmp/x",
		"cat /etc/passwd > /tmp/x",
		"ls; reboot",
		"ls && reboot",
		"echo $(id)",
		"sed -i s/a/b/ /etc/asterisk/sip.conf",
		"find / -name x -delete",
		"find / -exec rm {} ;",
		`asterisk -rx "core restart now"`,
		`asterisk -rx "channel originate Local/100 extension 200"`,
		`mysql -e "UPDATE users SET x=1"`,
		`mysql -e "SELECT * FROM cdr INTO OUTFILE '/tmp/x'"`,
		"systemctl restart asterisk",
		"docker compose up -d",
		"fwconsole reload",
		"sudo cat /etc/shadow",
		"awk 'BEGIN{system(\"id\")}'",
		"tail -f /var/log/x &",
		"",
	}
	for _, c := range refused {
		if err := checkReadOnly(c); err == nil {
			t.Errorf("%q should be refused", c)
		}
	}
}
