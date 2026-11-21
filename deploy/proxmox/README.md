# Proxmox firewall for the Shipwright container

Live on `saturn` for CT 134 since 2026-11-20. These are copies; the live files
are in `/etc/pve`:

| Here | On the Proxmox host | What |
| --- | --- | --- |
| `ct.fw` | `/etc/pve/firewall/<vmid>.fw` | The rules: SSH in from the LAN, DNS to the router, no other LAN or IPv6 out |
| `cluster.fw` | `/etc/pve/firewall/cluster.fw` | Turns the datacenter firewall on with ACCEPT policies, so nothing else is filtered |
| `host.fw` | `/etc/pve/nodes/<node>/host.fw` | Keeps the host's own firewall off |

The container's `net0` needs `firewall=1` (it has it). Check rules with
`pve-firewall compile` before applying, then `pve-firewall restart`.

Turning on the datacenter firewall makes every bridged packet on the host go
through iptables (`bridge-nf-call-iptables=1`), and conntrack-INVALID packets
are dropped for all guests. Guests without their own `<vmid>.fw` are
otherwise untouched.

**If the house's public IP changes**, update its entry in the `private` ipset,
or the container can reach the port forwards again through hairpin NAT.
Check with `curl -4 https://api.ipify.org` from inside the container.
