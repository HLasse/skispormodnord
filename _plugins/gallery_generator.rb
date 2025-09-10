require 'fileutils'
require 'mini_magick'

module Jekyll
  class GalleryGenerator < Generator
    safe true

    IMAGE_EXTENSIONS = %w(.jpg .jpeg .png .gif .webp)
    VIDEO_EXTENSIONS = %w(.mp4 .mov .webm)

    def generate(site)
      gallery_dir = File.join(site.source, "galleri")
      thumbs_dir  = File.join(gallery_dir, "thumbs")

      return unless Dir.exist?(gallery_dir)

      FileUtils.mkdir_p(thumbs_dir)

      items = []
      Dir.foreach(gallery_dir) do |file|
        next if file.start_with?(".")

        ext = File.extname(file).downcase
        path = File.join("galleri", file)

        if IMAGE_EXTENSIONS.include?(ext)
          items << { "name" => file, "path" => path, "type" => "image" }

          src_path   = File.join(gallery_dir, file)
          thumb_path = File.join(thumbs_dir, file)

          if needs_regeneration?(src_path, thumb_path)
            puts "Generating thumbnail for image #{file}"
            begin
              image = MiniMagick::Image.open(src_path)
              image.resize "400x400>" # max 400px width/height
              image.write thumb_path
            rescue => e
              puts "Error generating thumbnail for #{file}: #{e}"
            end
          end

          # Always register thumbnail with Jekyll
          site.static_files << Jekyll::StaticFile.new(
            site,
            site.source,
            "galleri/thumbs",
            file
          )

        elsif VIDEO_EXTENSIONS.include?(ext)
          items << { "name" => file, "path" => path, "type" => "video" }

          thumb_file = File.basename(file, ext) + "-thumb.jpg"
          thumb_path = File.join(thumbs_dir, thumb_file)
          video_src  = File.join(gallery_dir, file)

          if needs_regeneration?(video_src, thumb_path)
            puts "Generating thumbnail for video #{file}"
            system("ffmpeg -y -i \"#{video_src}\" -ss 00:00:01.000 -vframes 1 -vf 'scale=400:-1' \"#{thumb_path}\"")
          end

          # Always register thumbnail
          site.static_files << Jekyll::StaticFile.new(
            site,
            site.source,
            "galleri/thumbs",
            thumb_file
          )
        end
      end

      # Sort by filename
      items.sort_by! { |i| i["name"].downcase }

      site.pages << GalleryPage.new(site, site.source, "gallery_page.html", items)
    end

    private

    def needs_regeneration?(src, thumb)
      return true unless File.exist?(thumb)
      return true if File.mtime(src) > File.mtime(thumb)
      false
    end
  end

  class GalleryPage < Page
    def initialize(site, base, layout, items)
      @site = site
      @base = base
      @dir  = "galleri"
      @name = "index.html"

      self.process(@name)
      self.read_yaml(File.join(base, "_layouts"), layout)

      self.data["title"] = "Galleri"
      self.data["images"] = items
    end
  end
end
