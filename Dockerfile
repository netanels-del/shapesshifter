FROM node:20-bookworm-slim

# Install ffmpeg, imagemagick, and fonts
RUN apt-get update && apt-get install -y \
  ffmpeg \
  imagemagick \
  fonts-liberation \
  fonts-dejavu-core \
  fontconfig \
  && fc-cache -fv \
  && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node dependencies
RUN npm install --production

# Copy all project files
COPY . .

# Expose port
EXPOSE 3000

# Start the server
CMD ["node", "server.js"]
