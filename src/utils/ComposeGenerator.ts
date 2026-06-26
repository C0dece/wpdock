export interface ComposeOptions {
  id: string;
  name: string;          // slug
  sitePath: string;
  port: number;
  dbPort: number;
  phpVersion: string;
  adminUser: string;
  adminPassword: string;
  adminEmail: string;
}

export class ComposeGenerator {
  static generate(opts: ComposeOptions): string {
    const dbName = `wpdb_${opts.name}`;
    const dbUser = 'wpuser';
    const dbPass = 'wppass_' + opts.id.split('-')[0];
    const dbRootPass = 'root_' + opts.id.split('-')[0];
    const containerPrefix = `wpdock-${opts.name}`;

    return `version: "3.9"

services:
  db:
    image: mysql:8.0
    container_name: ${containerPrefix}-db
    restart: unless-stopped
    environment:
      MYSQL_ROOT_PASSWORD: "${dbRootPass}"
      MYSQL_DATABASE: "${dbName}"
      MYSQL_USER: "${dbUser}"
      MYSQL_PASSWORD: "${dbPass}"
    volumes:
      - ${containerPrefix}-db:/var/lib/mysql
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost"]
      timeout: 20s
      retries: 10

  wordpress:
    image: wordpress:php${opts.phpVersion}-apache
    container_name: ${containerPrefix}-wp
    restart: unless-stopped
    depends_on:
      db:
        condition: service_healthy
    ports:
      - "${opts.port}:80"
    environment:
      WORDPRESS_DB_HOST: db
      WORDPRESS_DB_NAME: "${dbName}"
      WORDPRESS_DB_USER: "${dbUser}"
      WORDPRESS_DB_PASSWORD: "${dbPass}"
      WORDPRESS_TABLE_PREFIX: wp_
    volumes:
      - "${opts.sitePath}/public/wp-content:/var/www/html/wp-content"
      - ${containerPrefix}-wp:/var/www/html
    labels:
      wpdock.site.id: "${opts.id}"
      wpdock.site.name: "${opts.name}"

  wpcli:
    image: wordpress:cli-php${opts.phpVersion}
    container_name: ${containerPrefix}-cli
    depends_on:
      wordpress:
        condition: service_started
    volumes:
      - "${opts.sitePath}/public/wp-content:/var/www/html/wp-content"
      - ${containerPrefix}-wp:/var/www/html
    environment:
      WORDPRESS_DB_HOST: db
      WORDPRESS_DB_NAME: "${dbName}"
      WORDPRESS_DB_USER: "${dbUser}"
      WORDPRESS_DB_PASSWORD: "${dbPass}"
    entrypoint: /bin/sh
    command: >
      -c "
        sleep 10 &&
        wp core install
          --url='http://localhost:${opts.port}'
          --title='${opts.name}'
          --admin_user='${opts.adminUser}'
          --admin_password='${opts.adminPassword}'
          --admin_email='${opts.adminEmail}'
          --skip-email
          --allow-root || true
      "

volumes:
  ${containerPrefix}-db:
  ${containerPrefix}-wp:
`;
  }
}
