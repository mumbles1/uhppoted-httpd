FROM alpine

EXPOSE 8080
EXPOSE 8443

RUN mkdir -p /usr/local/etc/uhppoted/httpd
RUN mkdir -p /usr/local/etc/uhppoted/httpd/grules
RUN mkdir -p /usr/local/etc/uhppoted/httpd/system
RUN mkdir -p /usr/local/etc/uhppoted/httpd/audit
RUN mkdir -p /data

ENV UHPPOTED_CREDENTIALS_CSV=/data/credentials.csv
VOLUME ["/data"]

COPY uhppoted.conf /usr/local/etc/uhppoted
COPY auth.json     /usr/local/etc/uhppoted/httpd
COPY acl.grl       /usr/local/etc/uhppoted/httpd

ADD grules  /usr/local/etc/uhppoted/httpd/grules
ADD system  /opt/uhppoted/defaults/system
ADD html    /usr/local/etc/uhppoted/httpd/html
COPY auth.json /opt/uhppoted/defaults/auth.json
COPY entrypoint.sh /opt/uhppoted/entrypoint.sh
RUN chmod +x /opt/uhppoted/entrypoint.sh

WORKDIR /opt/uhppoted 
COPY uhppoted-httpd .

ENTRYPOINT ["/opt/uhppoted/entrypoint.sh"]
